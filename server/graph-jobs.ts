import type { FrontierTask, GraphJob, JobCheckpoint, LeasedGraphJob, PageCommit } from '../shared/graph-jobs.ts';
import type { GraphResponse, Paper } from '../shared/types.ts';
import { GraphResponseSchema } from '../shared/schemas.ts';
import { buildGraph } from './graph.ts';
import type { GraphJobStore } from './graph-store.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { auditedConflict, SEEDS, seedConflict } from './integrity.ts';
import { ID_PATTERN, normalizeWork, ProviderError, SELECT, workId, type OpenAlexProvider, type OpenAlexWork, type WorksPage } from './openalex.ts';

export type GraphJobProvider = Pick<OpenAlexProvider, 'getPaper' | 'request' | 'metadata'>;

// These small acquisition counters travel with the durable JSON checkpoint, not the process.
type Task = FrontierTask & { attempts?: number };
type Checkpoint = JobCheckpoint & {
  frontier: Task[];
  firstFetchedAt?: string;
  missingReferences?: number;
  skippedTasks?: number;
  cursorStalls?: number;
};

const TOP = 'cited_by_count:desc';
const RECENT = 'publication_date:desc';
const MAX_ANCHORS = 64;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function ids(values: string[] = []): string[] {
  return [...new Set(values.map(workId).filter((id): id is string => id !== null))];
}

function enqueue(checkpoint: Checkpoint, task: Task) {
  const key = (item: Task) => JSON.stringify([item.kind, item.ids, item.order, item.cursor, item.depth, item.pages ?? 0]);
  if (!checkpoint.frontier.some(item => key(item) === key(task))) checkpoint.frontier.push(task);
}

function expand(checkpoint: Checkpoint, paper: Paper, work: OpenAlexWork, depth: number) {
  const references = paper.references;
  // Explicit ID retrieval is always a single <=100-record request, never provider.batch().
  const limit = depth === 1 ? references.length : Math.min(100, references.length);
  if (limit) enqueue(checkpoint, { kind: 'batch', ids: references.slice(0, 100), depth });
  const related = ids(work.related_works).filter(id => id !== paper.id && !references.includes(id)).slice(0, 100);
  if (related.length && depth === 1) enqueue(checkpoint, { kind: 'batch', ids: related, depth });
  enqueue(checkpoint, { kind: 'citing', ids: [paper.id], order: TOP, cursor: '*', depth });
  // Origins have both full bounded orders; second-hop anchors share five pages (3 top + 2 recent).
  enqueue(checkpoint, { kind: 'citing', ids: [paper.id], order: RECENT, cursor: '*', depth });
  if (depth === 1) {
    const diverse = references.slice(0, 24);
    for (let start = 0; start < diverse.length; start += 8) {
      enqueue(checkpoint, { kind: 'shared', ids: diverse.slice(start, start + 8), order: TOP, cursor: '*', depth });
    }
  }
  // Start every acquisition lane before long reference lists consume the request budget.
  for (let start = 100; start < limit; start += 100) {
    enqueue(checkpoint, { kind: 'batch', ids: references.slice(start, start + 100), depth });
  }
}

/** Each claim does at most one provider page, then atomically commits and releases its lease. */
export class GraphJobRunner {
  constructor(
    private readonly store: GraphJobStore,
    private readonly provider: GraphJobProvider,
    private readonly options: { stepMs?: number; requestMs?: number; maxResponseBytes?: number } = {},
  ) {
    for (const [value, maximum] of [[options.stepMs ?? 40_000, 40_000], [options.requestMs ?? 12_000, 12_000], [options.maxResponseBytes ?? MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES]]) {
      if (!Number.isInteger(value) || value < 1 || value > maximum) throw new RangeError('Invalid graph runner bounds');
    }
  }

  async runStep(id?: string, shutdown?: AbortSignal): Promise<GraphJob | undefined> {
    shutdown?.throwIfAborted();
    const deadline = Date.now() + (this.options.stepMs ?? 40_000);
    const signal = AbortSignal.any([AbortSignal.timeout(this.options.stepMs ?? 40_000), ...(shutdown ? [shutdown] : [])]);
    await this.store.ready;
    signal.throwIfAborted();
    const job = await this.store.claim(id);
    if (!job) return undefined;
    signal.throwIfAborted();
    const checkpoint = structuredClone(job.checkpoint) as Checkpoint;
    const empty = (page: Omit<PageCommit, 'papers' | 'fetchedAt' | 'checkpoint' | 'requestUsed'> = {}) => {
      signal.throwIfAborted();
      return this.store.commit(job, {
        papers: [], fetchedAt: checkpoint.firstFetchedAt ?? new Date().toISOString(),
        checkpoint, requestUsed: false, state: 'queued', nextRunAt: null, error: null, ...page,
      });
    };

    if (!job.origins.length || job.origins.length > 3 || new Set(job.origins).size !== job.origins.length || job.origins.some(origin => !ID_PATTERN.test(origin))) {
      return empty({ state: 'failed', stopReason: 'invalid_origins', error: 'Graph jobs require 1 to 3 distinct paper IDs; Semantic Scholar origins are not supported.' });
    }
    if (job.phase !== 'acquire') return this.publish(job, checkpoint, signal, deadline);

    // Reconstruct an empty initial frontier, but never restart an exhausted acquisition.
    if (!checkpoint.frontier.length && !checkpoint.seeded.length) {
      checkpoint.frontier = job.origins.map(origin => ({ kind: 'seed', ids: [origin], depth: 0 }));
    }
    const stopped = job.requestsUsed >= job.requestBudget ? 'request_budget'
      : job.acquiredCount >= job.candidateBudget ? 'candidate_budget'
      : job.referenceCount >= job.referenceBudget ? 'reference_budget'
      : !checkpoint.frontier.length ? 'frontier_exhausted' : null;
    if (stopped) {
      if (job.origins.some(origin => !checkpoint.seeded.includes(origin))) {
        return empty({ state: 'failed', stopReason: stopped, error: 'Acquisition ended before all origins could be fetched; no graph was fabricated.' });
      }
      return empty({ phase: 'score', stopReason: stopped });
    }

    // Seeds take precedence over rotated continuations so every origin has a foothold.
    const seed = checkpoint.frontier.findIndex(task => task.kind === 'seed');
    const taskIndex = seed < 0 ? 0 : seed;
    const task = checkpoint.frontier[taskIndex];
    signal.throwIfAborted();
    const reservation = await this.store.reserveRequest(job);
    signal.throwIfAborted();
    if (!reservation.allowed) {
      return empty({ state: 'paused', nextRunAt: reservation.nextRunAt ?? new Date(Date.now() + 30_000).toISOString() });
    }

    let works: OpenAlexWork[];
    let papers: Paper[];
    let fetchedAt: string;
    let nextCursor: string | null | undefined;
    try {
      const transport = AbortSignal.any([signal, AbortSignal.timeout(this.options.requestMs ?? 12_000)]);
      if (task.kind === 'seed') {
        const work = await this.provider.getPaper(task.ids[0], transport);
        if (workId(work.id) !== task.ids[0]) throw new ProviderError(502, 'OpenAlex returned the wrong origin');
        works = [work];
        fetchedAt = this.provider.metadata(work).fetchedAt;
      } else {
        const page = await this.provider.request<WorksPage>('/works', {
          filter: task.kind === 'batch' ? `openalex_id:${task.ids.slice(0, 100).join('|')}` : `cites:${task.ids.slice(0, 8).join('|')}`,
          per_page: '100', select: SELECT,
          ...(task.kind !== 'batch' ? { sort: task.order ?? TOP, cursor: task.cursor ?? '*' } : {}),
        }, transport);
        if (!Array.isArray(page.results) || page.results.length > 100 || !Number.isInteger(page.meta?.count) || page.meta.count < 0) {
          throw new ProviderError(502, 'Invalid OpenAlex page');
        }
        works = page.results;
        fetchedAt = this.provider.metadata(page).fetchedAt;
        nextCursor = (page.meta as WorksPage['meta'] & { next_cursor?: string | null }).next_cursor;
        if (nextCursor !== undefined && nextCursor !== null && (typeof nextCursor !== 'string' || !nextCursor || nextCursor.length > 2000)) {
          throw new ProviderError(502, 'Invalid OpenAlex cursor');
        }
        if (task.kind !== 'batch' && works.length && nextCursor === (task.cursor ?? '*')) {
          checkpoint.cursorStalls = (checkpoint.cursorStalls ?? 0) + 1;
          throw new ProviderError(502, 'OpenAlex cursor stalled');
        }
      }
      signal.throwIfAborted();
      if (!Number.isFinite(Date.parse(fetchedAt))) throw new ProviderError(502, 'Missing OpenAlex acquisition timestamp');
      // Normalize the whole page before changing its cursor. A crash replays only this page.
      papers = [...new Map(works.map(work => {
        const paper = normalizeWork(work);
        return [paper.id, paper] as const;
      })).values()];
      if (task.kind === 'batch' && papers.some(paper => !task.ids.includes(paper.id))) throw new ProviderError(502, 'OpenAlex returned an unrequested work');
    } catch (error) {
      // Shutdown/step expiry leaves the reserved request counted and the cursor unchanged.
      // The durable lease expires naturally; never acknowledge an aborted fetch.
      signal.throwIfAborted();
      const status = error instanceof ProviderError ? error.status : 503;
      if (status === 404 && task.kind === 'seed') {
        return empty({ state: 'failed', stopReason: 'unknown_origin', error: `Origin paper ${task.ids[0]} was not found.` });
      }
      if ([400, 401, 403].includes(status)) {
        return empty({ state: 'failed', stopReason: 'provider_rejected', error: `The paper data service rejected acquisition (HTTP ${status}).` });
      }
      if (job.requestsUsed + 1 >= job.requestBudget && job.origins.every(origin => checkpoint.seeded.includes(origin))) {
        checkpoint.skippedTasks = (checkpoint.skippedTasks ?? 0) + 1;
        return empty({ phase: 'score', stopReason: 'request_budget', error: 'The final reserved acquisition request failed; publishing the fetched neighborhood only.' });
      }
      if (status === 429) {
        const retryAfter = (error as ProviderError & { retryAfter?: number }).retryAfter;
        const wait = typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 3_600_000;
        return empty({ state: 'paused', nextRunAt: new Date(Date.now() + wait).toISOString(), error: 'The paper data service rate limited acquisition; the checkpoint will resume after Retry-After.' });
      }
      task.attempts = (task.attempts ?? 0) + 1;
      if (status === 404 || task.attempts >= 3) {
        if (task.kind === 'seed') return empty({ state: 'failed', stopReason: 'provider_unavailable', error: `Origin paper ${task.ids[0]} could not be fetched after three attempts.` });
        checkpoint.frontier.splice(taskIndex, 1);
        checkpoint.skippedTasks = (checkpoint.skippedTasks ?? 0) + 1;
        return empty({ error: 'An acquisition page was unavailable; coverage is incomplete.' });
      }
      return empty({ state: 'paused', nextRunAt: new Date(Date.now() + 30_000).toISOString(), error: 'Acquisition failed temporarily; this page will be retried.' });
    }

    checkpoint.firstFetchedAt = [checkpoint.firstFetchedAt, fetchedAt].filter((date): date is string => !!date).sort()[0];
    checkpoint.missingReferences = (checkpoint.missingReferences ?? 0) + works.filter(work => work.referenced_works == null).length;
    checkpoint.frontier.splice(taskIndex, 1);
    if (task.kind === 'seed') {
      const paper = papers[0];
      if (!checkpoint.seeded.includes(paper.id)) {
        checkpoint.seeded.push(paper.id);
        expand(checkpoint, paper, works[0], 1);
      }
    } else if (task.kind !== 'batch') {
      const pages = (task.pages ?? 0) + 1;
      const limit = task.depth === 1 ? (task.kind === 'citing' ? 100 : 20) : task.order === RECENT ? 2 : 3;
      if (papers.length && nextCursor && pages < limit) enqueue(checkpoint, { ...task, cursor: nextCursor, pages, attempts: 0 });
    }

    // Select high-centrality anchors from actual first-hop records, never one task per paper.
    // Page-local reference frequency breaks ties before citation rank; no full-store scan here.
    if (task.kind !== 'seed' && task.depth === 1 && checkpoint.expanded.length < MAX_ANCHORS) {
      const frequency = new Map<string, number>();
      for (const paper of papers) for (const reference of paper.references) frequency.set(reference, (frequency.get(reference) ?? 0) + 1);
      const centrality = (paper: Paper) => paper.references.reduce((sum, reference) => sum + (job.origins.includes(reference) ? 100 : frequency.get(reference) ?? 0), 0);
      const ranked = papers.filter(paper => !job.origins.includes(paper.id) && !checkpoint.expanded.includes(paper.id) && paper.citations > 0)
        .sort((a, b) => centrality(b) - centrality(a) || b.citations - a.citations || a.id.localeCompare(b.id));
      for (const paper of ranked.slice(0, Math.min(2, MAX_ANCHORS - checkpoint.expanded.length))) {
        checkpoint.expanded.push(paper.id);
        expand(checkpoint, paper, works.find(work => workId(work.id) === paper.id)!, 2);
      }
    }

    signal.throwIfAborted();
    const allSeeds = job.origins.every(origin => checkpoint.seeded.includes(origin));
    return this.store.commit(job, {
      papers, fetchedAt, checkpoint, requestUsed: false, state: 'queued', nextRunAt: null, error: null,
      ...(allSeeds && job.requestsUsed + 1 >= job.requestBudget ? { phase: 'score', stopReason: 'request_budget' } : {}),
    });
  }

  async runBatch(maxSteps = 1, deadline = Date.now() + 40_000, signal?: AbortSignal): Promise<GraphJob[]> {
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 1500 || !Number.isFinite(deadline)) throw new RangeError('Invalid graph batch bounds');
    const results: GraphJob[] = [];
    while (results.length < maxSteps && Date.now() < deadline) {
      signal?.throwIfAborted();
      const stepSignal = AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.ceil(deadline - Date.now()))), ...(signal ? [signal] : [])]);
      const result = await this.runStep(undefined, stepSignal);
      if (!result) break;
      results.push(result);
      if (results.length < maxSteps && Date.now() + 300 < deadline) await delay(300, undefined, { signal });
    }
    return results;
  }

  private async publish(job: LeasedGraphJob, checkpoint: Checkpoint, signal: AbortSignal, deadline: number): Promise<GraphJob> {
    const papers = await this.store.papers(job);
    signal.throwIfAborted();
    const firstFetchedAt = checkpoint.firstFetchedAt;
    const commit = (page: Partial<PageCommit>) => {
      signal.throwIfAborted();
      // Synchronous indexed scoring can delay the AbortSignal timer until the next turn.
      if (Date.now() >= deadline) throw new DOMException('Graph step timed out', 'TimeoutError');
      return this.store.commit(job, { papers: [], fetchedAt: firstFetchedAt ?? new Date().toISOString(), checkpoint, requestUsed: false, nextRunAt: null, ...page });
    };
    if (!firstFetchedAt || job.origins.some(origin => !papers.some(paper => paper.id === origin))) {
      return commit({ state: 'failed', stopReason: 'missing_origin_metadata', error: 'Stored origin metadata or acquisition provenance is missing; no graph was fabricated.' });
    }
    const warnings = ['This is a bounded, sampled neighborhood, not an exhaustive literature graph. Related works nominate candidates only; edges require observed citation evidence. Co-citation is sample-local. Missing references/abstracts and source indexing errors may reduce coverage.'];
    if (checkpoint.missingReferences) warnings.push(`${checkpoint.missingReferences} fetched records had missing reference metadata (empty for scoring).`);
    if (checkpoint.skippedTasks) warnings.push(`${checkpoint.skippedTasks} acquisition tasks were skipped after provider errors; coverage is incomplete.`);
    if (checkpoint.cursorStalls) warnings.push(`${checkpoint.cursorStalls} stalled cursor responses were retried without advancing acquisition.`);
    for (const origin of job.origins) {
      const paper = papers.find(paper => paper.id === origin)!;
      const audit = auditedConflict(paper);
      if (audit) warnings.push(audit);
      const seed = SEEDS.find(seed => seed.title.test(paper.title));
      const conflict = seed && seedConflict(paper, seed);
      if (conflict) warnings.push(conflict);
    }
    let result: GraphResponse;
    try {
      result = buildGraph(papers, job.origins, {
        source: 'live', provider: 'openalex', fetchedAt: firstFetchedAt, candidateCount: papers.length,
        candidateBudget: job.candidateBudget, referenceCount: job.referenceCount, jobId: job.id,
        acquisitionStop: job.stopReason ?? 'frontier_exhausted', algorithm: 'indexed-v2', warning: warnings.join(' '),
        coverage: `${papers.length}/${job.candidateBudget} unique fetched candidates, ${job.referenceCount}/${job.referenceBudget} reference entries, ${job.requestsUsed}/${job.requestBudget} reserved requests. Acquisition stopped: ${job.stopReason ?? 'frontier_exhausted'}. Origins: reference batches and related IDs, up to 100 top-cited and 100 recent citing pages each; three groups of up to eight of the first 24 references, up to 20 pages each; up to 64 selected second-hop anchors with at most five citing pages each. Each page contains at most 100 actual records. Citation-ranked and recent sampling are not exhaustive; co-citation is sample-local.`,
      });
      signal.throwIfAborted();
      const audited = new Set(job.origins);
      for (const paper of [...result.nodes, ...result.prior, ...result.derivative]) {
        if (audited.has(paper.id)) continue;
        audited.add(paper.id);
        const warning = auditedConflict(paper);
        if (warning) result.meta.warning = `${result.meta.warning} ${warning}`;
      }
      // Leave headroom for the persisted result envelope and JSONB whitespace.
      const limit = Math.min(this.options.maxResponseBytes ?? MAX_RESPONSE_BYTES, Math.floor(MAX_RESPONSE_BYTES * 0.8));
      if (Buffer.byteLength(JSON.stringify(result)) > limit) {
        // Preserve every origin field and the stored papers. Only projection abstracts shrink.
        for (const list of [result.nodes, result.prior, result.derivative]) {
          for (const paper of list) if (!job.origins.includes(paper.id)) paper.abstract = paper.abstract.slice(0, 1000);
        }
        result.meta.warning = `${result.meta.warning} Non-origin response abstracts were shortened to fit the deployment response limit; stored metadata is unchanged.`;
      }
      if (Buffer.byteLength(JSON.stringify(result)) > limit) {
        return commit({ state: 'failed', phase: 'publish', stopReason: 'response_too_large', error: '413: This graph exceeds the 4 MiB deployment response limit; reduce the neighborhood or origin count.' });
      }
      GraphResponseSchema.parse(result);
    } catch (error) {
      signal.throwIfAborted();
      return commit({ state: 'failed', error: 'Graph scoring or result validation failed; source metadata was not altered.' });
    }
    // A failed/stale store commit must remain a durability error, not a scoring failure.
    return commit({ state: 'completed', phase: 'publish', result, error: null });
  }
}
