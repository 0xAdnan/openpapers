import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { GraphJobSchema, type GraphJob, type LeasedGraphJob, type PageCommit } from '../shared/graph-jobs.ts';
import { GraphResponseSchema } from '../shared/schemas.ts';
import type { Paper } from '../shared/types.ts';
import snapshot from '../data/snapshot.json';
import { buildGraph } from './graph.ts';
import { GraphJobRunner, type GraphJobProvider } from './graph-jobs.ts';
import type { GraphJobStore } from './graph-store.ts';
import { ProviderError, SELECT, type OpenAlexWork, type WorksPage } from './openalex.ts';
import { runWorker } from './worker.ts';

const OLD = '2001-01-01T00:00:00.000Z';
const NEW = '2026-10-13T00:00:00.000Z';
const work = (id: string, references: string[] | undefined = [], citations = 0): OpenAlexWork => ({
  id: `https://openalex.org/${id}`, display_name: `Fixture ${id}`, publication_year: 2020,
  referenced_works: references, cited_by_count: citations,
});
const page = (results: OpenAlexWork[] = [], next_cursor: string | null = null, count = results.length): WorksPage => ({ results, meta: { count, next_cursor } } as WorksPage);

// A transactional test double: reservations survive crashes, commit releases the lease,
// duplicates are first-write-wins, and caps are imposed by the store, not runner guesses.
class MemoryStore implements GraphJobStore {
  ready = Promise.resolve();
  rows = new Map<string, LeasedGraphJob>();
  records = new Map<string, Map<string, Paper>>();
  held = new Set<string>();
  commits: PageCommit[] = [];
  reserved = 0;
  paperReads = 0;
  closed = 0;
  deniedUntil: string | null = null;
  crashCommit = false;

  async create(origins = ['W1'], candidateBudget = 5000, requestBudget = 100): Promise<GraphJob> {
    const id = randomUUID();
    const job: LeasedGraphJob = {
      id, origins, state: 'queued', phase: 'acquire', candidateBudget, requestBudget, acquiredCount: 0,
      referenceCount: 0, referenceBudget: 2_000_000, requestsUsed: 0, createdAt: NEW, updatedAt: NEW,
      nextRunAt: null, stopReason: null, error: null, result: null, leaseToken: '',
      checkpoint: { frontier: origins.map(id => ({ kind: 'seed', ids: [id], depth: 0 })), expanded: [], seeded: [] },
    };
    this.rows.set(id, job);
    this.records.set(id, new Map());
    return structuredClone(job);
  }
  async get(id: string) { const job = this.rows.get(id); return job && structuredClone(job); }
  async claim(id?: string) {
    const job = [...this.rows.values()].find(row => (!id || id === row.id) && !this.held.has(row.id)
      && !['completed', 'failed'].includes(row.state) && (!row.nextRunAt || Date.parse(row.nextRunAt) <= Date.now()));
    if (!job) return undefined;
    this.held.add(job.id);
    job.leaseToken = randomUUID();
    job.state = 'running';
    return structuredClone(job);
  }
  async reserveRequest(job: LeasedGraphJob) {
    if (this.deniedUntil) return { allowed: false, nextRunAt: this.deniedUntil };
    const row = this.rows.get(job.id)!;
    assert.ok(row.requestsUsed < row.requestBudget);
    row.requestsUsed++;
    this.reserved++;
    return { allowed: true, nextRunAt: null };
  }
  async commit(job: LeasedGraphJob, commit: PageCommit) {
    if (this.crashCommit) { this.crashCommit = false; throw new Error('Simulated crash before checkpoint commit'); }
    assert.ok(this.held.has(job.id));
    assert.equal(this.rows.get(job.id)!.leaseToken, job.leaseToken);
    assert.equal(commit.requestUsed, false, 'reserveRequest already charged the request');
    this.commits.push(structuredClone(commit));
    const row = this.rows.get(job.id)!;
    const records = this.records.get(job.id)!;
    for (const paper of commit.papers) {
      if (records.has(paper.id)) continue;
      if (records.size >= row.candidateBudget) { row.phase = 'score'; row.stopReason = 'candidate_budget'; break; }
      if (row.referenceCount + paper.references.length > row.referenceBudget) { row.phase = 'score'; row.stopReason = 'reference_budget'; break; }
      records.set(paper.id, structuredClone(paper));
      row.referenceCount += paper.references.length;
    }
    row.acquiredCount = records.size;
    row.checkpoint = structuredClone(commit.checkpoint);
    for (const key of ['state', 'phase', 'nextRunAt', 'stopReason', 'error', 'result'] as const) {
      if (commit[key] !== undefined) Object.assign(row, { [key]: structuredClone(commit[key]) });
    }
    this.held.delete(job.id);
    return structuredClone(row);
  }
  async papers(job: LeasedGraphJob) { this.paperReads++; return structuredClone([...this.records.get(job.id)!.values()]); }
  async close() { this.closed++; }
  resume(id: string) { this.rows.get(id)!.nextRunAt = null; }
  expireLease(id: string) { this.held.delete(id); }
}

type Call = { path: string; params: Record<string, string>; signal?: AbortSignal };
class FakeProvider implements GraphJobProvider {
  calls: Call[] = [];
  constructor(private handler: (call: Call) => WorksPage | OpenAlexWork | Promise<WorksPage | OpenAlexWork> = call => call.path === '/works' ? page() : work(call.path.slice(7))) {}
  metadata() { return { source: 'live' as const, fetchedAt: this.calls.length === 1 ? NEW : OLD }; }
  async request<T extends WorksPage | OpenAlexWork>(path: string, params: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const call = { path, params, signal };
    this.calls.push(call);
    return await this.handler(call) as T;
  }
  getPaper(id: string, signal?: AbortSignal) { return this.request<OpenAlexWork>(`/works/${id}`, { select: SELECT }, signal); }
}

async function finish(runner: GraphJobRunner, store: MemoryStore, id: string, limit = 1502) {
  for (let i = 0; i < limit; i++) {
    const result = await runner.runStep(id);
    if (!result || ['completed', 'failed', 'paused'].includes(result.state)) return result ?? store.get(id);
  }
  assert.fail('Job did not finish within bounded steps');
}

test('one page per claim, seeds first for each origin, <=100 ID batches and diverse shared groups', async () => {
  const store = new MemoryStore();
  const job = await store.create(['W1', 'W2', 'W3']);
  const references = Array.from({ length: 225 }, (_, n) => `W${1000 + n}`);
  const provider = new FakeProvider(call => call.path === '/works' ? page() : { ...work(call.path.slice(7), references), related_works: ['W9999'] });
  const runner = new GraphJobRunner(store, provider);
  for (let i = 0; i < 3; i++) {
    await runner.runStep(job.id);
    assert.equal(provider.calls.length, i + 1);
    assert.equal(store.held.size, 0);
  }
  assert.deepEqual(provider.calls.map(call => call.path), ['/works/W1', '/works/W2', '/works/W3']);
  const checkpoint = store.rows.get(job.id)!.checkpoint;
  assert.equal(checkpoint.seeded.length, 3);
  assert.ok(checkpoint.frontier.filter(task => task.kind === 'batch').every(task => task.ids.length <= 100));
  assert.deepEqual(checkpoint.frontier.filter(task => task.kind === 'shared').map(task => task.ids), [references.slice(0, 8), references.slice(8, 16), references.slice(16, 24)]);
  assert.equal(checkpoint.frontier.filter(task => task.kind === 'citing').length, 6);
  await runner.runStep(job.id);
  assert.equal(provider.calls.at(-1)!.params.per_page, '100');
  assert.equal(provider.calls.at(-1)!.params.select, SELECT);
  assert.equal(store.paperReads, 0);
});

test('reservation is before transport, persists once, and denied requests pause without fetching or cursor movement', async () => {
  const store = new MemoryStore();
  const job = await store.create();
  const provider = new FakeProvider(() => { assert.equal(store.reserved, 1); return work('W1'); });
  await new GraphJobRunner(store, provider).runStep(job.id);
  assert.equal(store.rows.get(job.id)!.requestsUsed, 1);
  const before = structuredClone(store.rows.get(job.id)!.checkpoint);
  const nextRunAt = new Date(Date.now() + 60_000).toISOString();
  store.deniedUntil = nextRunAt;
  const result = await new GraphJobRunner(store, provider).runStep(job.id);
  assert.equal(result!.state, 'paused');
  assert.equal(result!.nextRunAt, nextRunAt);
  assert.equal(provider.calls.length, 1);
  assert.deepEqual(store.rows.get(job.id)!.checkpoint, before);
  assert.equal(store.held.size, 0);
  assert.equal(await new GraphJobRunner(store, provider).runStep(job.id), undefined);
});

test('request budget transitions to scoring with progress intact and publishes sparse multi-origin graph without fake edges', async () => {
  const store = new MemoryStore();
  const job = await store.create(['W1', 'W2', 'W3'], 5000, 3);
  const provider = new FakeProvider();
  const result = await finish(new GraphJobRunner(store, provider), store, job.id);
  assert.equal(result!.state, 'completed');
  assert.equal(result!.stopReason, 'request_budget');
  assert.equal(result!.acquiredCount, 3);
  assert.equal(provider.calls.length, 3);
  assert.equal(store.paperReads, 1);
  assert.equal(result!.result!.nodes.length, 3);
  assert.deepEqual(result!.result!.edges, []);
  assert.deepEqual(result!.result!.origins, job.origins);
  assert.equal(result!.result!.meta.fetchedAt, OLD);
  assert.equal(result!.result!.meta.provider, 'openalex');
  assert.match(result!.result!.meta.warning!, /sampled|no artificial edges/);
  GraphJobSchema.parse(result);
  GraphResponseSchema.parse(result!.result);
});

test('a failed final reserved request publishes existing progress without waiting for another retry', async () => {
  const store = new MemoryStore();
  const job = await store.create(['W1'], 5000, 2);
  const provider = new FakeProvider(call => {
    if (call.path === '/works/W1') return work('W1');
    throw new ProviderError(503);
  });
  const runner = new GraphJobRunner(store, provider);
  await runner.runStep(job.id);
  const lastPage = await runner.runStep(job.id);
  assert.equal(lastPage!.phase, 'score');
  assert.equal(lastPage!.nextRunAt, null);
  assert.equal(lastPage!.stopReason, 'request_budget');
  const result = await runner.runStep(job.id);
  assert.equal(result!.state, 'completed');
  assert.equal(result!.acquiredCount, 1);
  assert.match(result!.result!.meta.warning!, /skipped after provider errors/);
});

test('restart after crash keeps reservation and retries the same page with deduplicated records', async () => {
  const store = new MemoryStore();
  const job = await store.create();
  const provider = new FakeProvider(call => call.path === '/works/W1' ? work('W1') : page([work('W10', ['W99']), work('W10', ['W99'])], 'next'));
  await new GraphJobRunner(store, provider).runStep(job.id);
  const before = structuredClone(store.rows.get(job.id)!.checkpoint);
  store.crashCommit = true;
  await assert.rejects(new GraphJobRunner(store, provider).runStep(job.id), /Simulated crash/);
  assert.equal(store.rows.get(job.id)!.requestsUsed, 2);
  assert.deepEqual(store.rows.get(job.id)!.checkpoint, before);
  store.expireLease(job.id);
  await new GraphJobRunner(store, provider).runStep(job.id);
  assert.equal(store.rows.get(job.id)!.requestsUsed, 3);
  assert.equal(store.rows.get(job.id)!.acquiredCount, 2);
  assert.deepEqual(provider.calls[1].params, provider.calls[2].params);
  assert.equal(store.held.size, 0);
});

test('cursor continuation rotates with original ordering and persists across runner instances', async () => {
  const store = new MemoryStore();
  const job = await store.create();
  const provider: FakeProvider = new FakeProvider(call => call.path === '/works/W1' ? work('W1') : page([work('W10')], `cursor-${provider.calls.length}`, 10_000));
  await new GraphJobRunner(store, provider).runStep(job.id);
  await new GraphJobRunner(store, provider).runStep(job.id);
  await new GraphJobRunner(store, provider).runStep(job.id);
  await new GraphJobRunner(store, provider).runStep(job.id);
  assert.deepEqual(provider.calls.slice(1).map(call => [call.params.sort, call.params.cursor]), [
    ['cited_by_count:desc', '*'], ['publication_date:desc', '*'], ['cited_by_count:desc', 'cursor-2'],
  ]);
  assert.equal(store.rows.get(job.id)!.acquiredCount, 2);
  assert.equal(store.paperReads, 0);
});

test('duplicate records and replayed pages cannot consume multiple anchor expansion slots', async () => {
  const store = new MemoryStore();
  const job = await store.create();
  const provider = new FakeProvider(call => call.path === '/works/W1' ? work('W1') : page([work('W10', ['W1'], 100), work('W10', ['W1'], 100)]));
  const runner = new GraphJobRunner(store, provider);
  await runner.runStep(job.id);
  await runner.runStep(job.id);
  await runner.runStep(job.id);
  const checkpoint = store.rows.get(job.id)!.checkpoint;
  assert.deepEqual(checkpoint.expanded, ['W10']);
  assert.equal(checkpoint.frontier.filter(task => task.kind === 'citing' && task.ids[0] === 'W10').length, 2);
  assert.equal(store.rows.get(job.id)!.acquiredCount, 2);
});

test('stalled cursor never acknowledges papers or advances and retries stop at three per task', async () => {
  const store = new MemoryStore();
  const job = await store.create();
  const provider = new FakeProvider(call => call.path === '/works/W1' ? work('W1') : page([work('W10')], call.params.cursor));
  const runner = new GraphJobRunner(store, provider);
  await runner.runStep(job.id);
  const task = structuredClone(store.rows.get(job.id)!.checkpoint.frontier[0]);
  for (let i = 0; i < 3; i++) {
    const result = await runner.runStep(job.id);
    assert.equal(result!.state, i < 2 ? 'paused' : 'queued');
    assert.equal(result!.acquiredCount, 1);
    if (i < 2) {
      const current = store.rows.get(job.id)!.checkpoint.frontier[0];
      assert.equal(current.cursor, task.cursor);
      assert.equal(current.pages, task.pages);
    }
    store.resume(job.id);
  }
  assert.equal(store.rows.get(job.id)!.checkpoint.frontier[0].order, 'publication_date:desc');
  assert.equal(store.rows.get(job.id)!.requestsUsed, 4);
});

test('404 seed is terminal; 429 honors seconds Retry-After, ordinary 503 pauses 30 seconds', async () => {
  for (const [status, retryAfter, expected] of [[404, undefined, 0], [429, 7200, 7200], [429, undefined, 3600], [503, undefined, 30]] as const) {
    const store = new MemoryStore();
    const job = await store.create();
    const provider = new FakeProvider(() => { throw Object.assign(new ProviderError(status), { retryAfter }); });
    const start = Date.now();
    const result = await new GraphJobRunner(store, provider).runStep(job.id);
    assert.equal(result!.state, status === 404 ? 'failed' : 'paused');
    if (expected) assert.ok(Math.abs(Date.parse(result!.nextRunAt!) - start - expected * 1000) < 1000);
    assert.equal(store.held.size, 0);
    assert.equal(store.rows.get(job.id)!.requestsUsed, 1);
  }
});

test('SIGTERM abort leaves the lease to expire, reserved request counted, no checkpoint acknowledged', async () => {
  const store = new MemoryStore();
  const job = await store.create();
  const shutdown = new AbortController();
  const provider = new FakeProvider(call => new Promise((_resolve, reject) => {
    call.signal!.addEventListener('abort', () => reject(call.signal!.reason), { once: true });
    shutdown.abort(new Error('SIGTERM'));
  }));
  await assert.rejects(new GraphJobRunner(store, provider).runStep(job.id, shutdown.signal), /SIGTERM/);
  assert.equal(store.commits.length, 0);
  assert.equal(store.rows.get(job.id)!.requestsUsed, 1);
  assert.equal(store.held.size, 1);
  assert.equal(store.rows.get(job.id)!.checkpoint.frontier[0].kind, 'seed');
});

test('transport timeout retries while whole-step timeout retains lease and checkpoint', async () => {
  for (const [stepMs, requestMs, aborted] of [[200, 10, false], [10, 100, true]] as const) {
    const store = new MemoryStore();
    const job = await store.create();
    const provider = new FakeProvider(call => new Promise((_resolve, reject) => {
      call.signal!.addEventListener('abort', () => reject(call.signal!.reason), { once: true });
      const keepAlive = setTimeout(() => reject(new Error('Test request outlived timeout')), 500);
      call.signal!.addEventListener('abort', () => clearTimeout(keepAlive), { once: true });
    }));
    const operation = new GraphJobRunner(store, provider, { stepMs, requestMs }).runStep(job.id);
    if (aborted) {
      await assert.rejects(operation, error => error instanceof Error && error.name === 'TimeoutError');
      assert.equal(store.commits.length, 0);
      assert.equal(store.held.size, 1);
    } else {
      assert.equal((await operation)!.state, 'paused');
      assert.equal(store.held.size, 0);
    }
  }
});

test('frontier exhaustion reports actual count rather than claiming its 50k budget', async () => {
  const store = new MemoryStore();
  const job = await store.create(['W1'], 50_000, 1500);
  const result = await finish(new GraphJobRunner(store, new FakeProvider()), store, job.id);
  assert.equal(result!.state, 'completed');
  assert.equal(result!.stopReason, 'frontier_exhausted');
  assert.equal(result!.result!.meta.candidateCount, 1);
  assert.equal(result!.result!.meta.candidateBudget, 50_000);
  assert.match(result!.result!.meta.coverage, /1\/50000/);
  assert.equal(store.paperReads, 1);
});

test('origin orders stop at 100 pages each and shared reference groups at 20 even if cursor remains live', async () => {
  const store = new MemoryStore();
  const job = await store.create(['W1'], 50_000, 1500);
  const references = Array.from({ length: 24 }, (_, n) => `W${1000 + n}`);
  const provider: FakeProvider = new FakeProvider(call => {
    if (call.path === '/works/W1') return work('W1', references);
    if (call.params.filter.startsWith('openalex_id:')) return page(call.params.filter.slice(12).split('|').map(id => work(id)));
    return page([work('W10', ['W1'])], `cursor-${provider.calls.length}`, 1_000_000);
  });
  const result = await finish(new GraphJobRunner(store, provider), store, job.id);
  assert.equal(result!.state, 'completed');
  assert.equal(result!.stopReason, 'frontier_exhausted');
  for (const order of ['cited_by_count:desc', 'publication_date:desc']) {
    assert.equal(provider.calls.filter(call => call.params.filter === 'cites:W1' && call.params.sort === order).length, 100);
  }
  for (let start = 0; start < 24; start += 8) {
    assert.equal(provider.calls.filter(call => call.params.filter === `cites:${references.slice(start, start + 8).join('|')}`).length, 20);
  }
  assert.equal(result!.acquiredCount, 26);
});

test('50k unique records are reachable under 1500 requests with a small bounded frontier', async () => {
  const store = new MemoryStore();
  const job = await store.create(['W1'], 50_000, 1500);
  let nextId = 10_000;
  const references = Array.from({ length: 24 }, (_, n) => `W${1000 + n}`);
  const provider: FakeProvider = new FakeProvider(call => {
    if (call.path === '/works/W1') return work('W1', references, 1000);
    if (call.params.filter.startsWith('openalex_id:')) return page(call.params.filter.slice(12).split('|').map(id => work(id, [], 10)));
    return page(Array.from({ length: 100 }, () => work(`W${nextId++}`, ['W1', 'W999'], 100)), `cursor-${provider.calls.length}`, 1_000_000);
  });
  const runner = new GraphJobRunner(store, provider);
  let maxFrontier = 0;
  let result: GraphJob | undefined;
  for (let step = 0; step < 1502; step++) {
    result = await runner.runStep(job.id);
    maxFrontier = Math.max(maxFrontier, store.rows.get(job.id)!.checkpoint.frontier.length);
    if (result!.state === 'completed') break;
    assert.notEqual(result!.state, 'failed');
  }
  assert.equal(result!.state, 'completed');
  assert.equal(result!.stopReason, 'candidate_budget');
  assert.equal(result!.acquiredCount, 50_000);
  assert.equal(result!.result!.meta.candidateCount, 50_000);
  assert.ok(provider.calls.length < 1500);
  assert.ok(maxFrontier < 300, `Frontier peaked at ${maxFrontier}, not one task per fetched paper`);
  assert.equal(store.rows.get(job.id)!.checkpoint.expanded.length, 64);
  assert.equal(store.paperReads, 1);
  assert.ok(result!.result!.edges.every(edge => edge.directCitation
    ? edge.weight === 0 && edge.sharedReferences + edge.coCitations === 0
    : edge.weight > 0 && edge.sharedReferences + edge.coCitations > 0));
  const secondHop = provider.calls.filter(call => call.params.filter?.startsWith('cites:') && !['cites:W1', `cites:${references.slice(0, 8).join('|')}`, `cites:${references.slice(8, 16).join('|')}`, `cites:${references.slice(16, 24).join('|')}`].includes(call.params.filter));
  const counts = new Map<string, number>();
  for (const call of secondHop) counts.set(call.params.filter, (counts.get(call.params.filter) ?? 0) + 1);
  assert.ok(counts.size <= 64);
  assert.ok([...counts.values()].every(count => count <= 5));
});

test('store enforces reference budget and source missing references are disclosed', async () => {
  const store = new MemoryStore();
  const job = await store.create();
  store.rows.get(job.id)!.referenceBudget = 1000;
  const references = Array.from({ length: 900 }, (_, n) => `W${1000 + n}`);
  const provider = new FakeProvider(call => {
    if (call.path === '/works/W1') return work('W1', references);
    const response = [work('W1000'), work('W1001', references)];
    response[0].referenced_works = undefined;
    return page(response);
  });
  const result = await finish(new GraphJobRunner(store, provider), store, job.id);
  assert.equal(result!.stopReason, 'reference_budget');
  assert.equal(result!.referenceCount, 900);
  assert.match(result!.result!.meta.warning!, /missing reference metadata/);
});

test('seed identity conflict preserves metadata and oldest acquisition timestamp', async () => {
  const store = new MemoryStore();
  const job = await store.create(['W1'], 5000, 1);
  const origin = { ...work('W1'), display_name: 'Attention Is All You Need', publication_year: 2025, doi: 'https://doi.org/10.65215/2q58a426', abstract_inverted_index: { Original: [0], abstract: [1] } };
  const result = await finish(new GraphJobRunner(store, new FakeProvider(() => origin)), store, job.id);
  const paper = result!.result!.nodes[0];
  assert.equal(paper.year, 2025);
  assert.equal(paper.doi, origin.doi);
  assert.equal(paper.abstract, 'Original abstract');
  assert.match(result!.result!.meta.warning!, /not a verified match|Data integrity warning/);
  assert.equal(result!.result!.meta.fetchedAt, NEW);
});

test('all bundled scholarly fixtures preserve origin metadata and indexed graph projections', async () => {
  for (const group of snapshot.groups) {
    const store = new MemoryStore();
    const job = await store.create([group.origin]);
    const row = store.rows.get(job.id)!;
    const papers = group.papers as Paper[];
    store.records.set(job.id, new Map(papers.map(paper => [paper.id, structuredClone(paper)])));
    row.acquiredCount = papers.length;
    row.referenceCount = papers.reduce((sum, paper) => sum + paper.references.length, 0);
    row.phase = 'score';
    row.stopReason = 'frontier_exhausted';
    row.checkpoint = Object.assign({ frontier: [], seeded: [group.origin], expanded: [] }, { firstFetchedAt: snapshot.fetchedAt });
    const provider = new FakeProvider(() => { assert.fail('Fixture scoring must not call OpenAlex'); });
    const result = (await new GraphJobRunner(store, provider).runStep(job.id))!.result!;
    assert.ok(result);
    const expected = buildGraph(papers, [group.origin], result.meta);
    assert.deepEqual(result.nodes, expected.nodes);
    assert.deepEqual(result.edges, expected.edges);
    assert.deepEqual(result.prior, expected.prior);
    assert.deepEqual(result.derivative, expected.derivative);
    const origin = papers.find(paper => paper.id === group.origin)!;
    for (const [key, value] of Object.entries(origin)) assert.deepEqual(result.nodes.find(paper => paper.isOrigin)![key as keyof Paper], value);
    assert.equal(result.meta.fetchedAt, snapshot.fetchedAt);
    assert.equal(store.paperReads, 1);
    assert.equal(provider.calls.length, 0);
  }
});

test('oversized response truncates only projected non-origin abstracts or reports 413 without rewriting origins', async () => {
  const store = new MemoryStore();
  const job = await store.create(['W1'], 5000, 2);
  const provider = new FakeProvider(call => call.path === '/works/W1' ? work('W1') : page([work('W10', ['W1', 'W99']), work('W11', ['W1', 'W99'])]));
  await new GraphJobRunner(store, provider).runStep(job.id);
  await new GraphJobRunner(store, provider).runStep(job.id);
  store.records.get(job.id)!.get('W1')!.abstract = 'Origin metadata unchanged';
  const result = await new GraphJobRunner(store, provider, { maxResponseBytes: 100 }).runStep(job.id);
  assert.equal(result!.state, 'failed');
  assert.match(result!.error!, /413/);
  assert.equal(store.records.get(job.id)!.get('W1')!.abstract, 'Origin metadata unchanged');
});

test('large projections shorten non-origin abstracts without mutating stored records', async () => {
  const store = new MemoryStore();
  const job = await store.create(['W1'], 5000, 2);
  const provider = new FakeProvider(call => call.path === '/works/W1' ? work('W1', ['W99']) : page([work('W99')]));
  const runner = new GraphJobRunner(store, provider);
  await runner.runStep(job.id);
  await runner.runStep(job.id);
  const records = store.records.get(job.id)!;
  records.set('W10', { ...records.get('W99')!, id: 'W10', references: ['W99'], abstract: 'x'.repeat(30_000), url: 'https://openalex.org/W10' });
  store.rows.get(job.id)!.acquiredCount = records.size;
  store.rows.get(job.id)!.referenceCount = 2;
  records.get('W1')!.abstract = 'Original origin abstract';
  const result = await new GraphJobRunner(store, provider, { maxResponseBytes: 10_000 }).runStep(job.id);
  assert.equal(result!.state, 'completed');
  assert.equal(result!.result!.nodes.find(paper => paper.id === 'W10')!.abstract.length, 1000);
  assert.equal(result!.result!.nodes.find(paper => paper.id === 'W1')!.abstract, 'Original origin abstract');
  assert.equal(records.get('W10')!.abstract.length, 30_000);
  assert.ok(Buffer.byteLength(JSON.stringify(result!.result)) <= 10_000);
});

test('failed publication checkpoint is retried after lease expiry rather than acknowledged as scoring failure', async () => {
  const store = new MemoryStore();
  const job = await store.create(['W1'], 5000, 1);
  const provider = new FakeProvider();
  const runner = new GraphJobRunner(store, provider);
  await runner.runStep(job.id);
  store.crashCommit = true;
  await assert.rejects(runner.runStep(job.id), /Simulated crash/);
  assert.equal(store.rows.get(job.id)!.phase, 'score');
  assert.equal(store.held.size, 1);
  store.expireLease(job.id);
  assert.equal((await runner.runStep(job.id))!.state, 'completed');
  assert.equal(provider.calls.length, 1);
});

test('batch response outside requested IDs is not admitted or acknowledged', async () => {
  const store = new MemoryStore();
  const job = await store.create();
  const provider = new FakeProvider(call => call.path === '/works/W1' ? work('W1', ['W99']) : page([work('W10')]));
  const runner = new GraphJobRunner(store, provider);
  await runner.runStep(job.id);
  assert.equal((await runner.runStep(job.id))!.state, 'paused');
  assert.equal(store.rows.get(job.id)!.acquiredCount, 1);
  assert.equal(store.rows.get(job.id)!.checkpoint.frontier[0].kind, 'batch');
});

test('batch is bounded, rejects invalid limits, and importing worker starts no executable', async () => {
  const store = new MemoryStore();
  const job = await store.create();
  const provider = new FakeProvider();
  const runner = new GraphJobRunner(store, provider);
  assert.equal((await runner.runBatch(2)).length, 2);
  assert.equal(provider.calls.length, 2);
  assert.equal((await runner.runBatch(2, Date.now() - 1)).length, 0);
  await assert.rejects(runner.runBatch(0), RangeError);
  assert.ok(await store.get(job.id));
  assert.equal(store.closed, 0);
});

test('worker drains steps until idle, SIGTERM interrupts wait, and store closes exactly once', async () => {
  const store = new MemoryStore();
  const job = await store.create();
  const signal = new AbortController();
  let calls = 0;
  await runWorker(store, { async runStep() {
    calls++;
    if (calls < 3) return job;
    setTimeout(() => signal.abort(), 5);
    return undefined;
  } }, signal.signal);
  assert.equal(calls, 3);
  assert.equal(store.closed, 1);
});

test('non-OpenAlex runtime origins are rejected before transport', async () => {
  const store = new MemoryStore();
  const job = await store.create(['S2:0123456789012345678901234567890123456789']);
  const provider = new FakeProvider();
  const result = await new GraphJobRunner(store, provider).runStep(job.id);
  assert.equal(result!.state, 'failed');
  assert.equal(provider.calls.length, 0);
  assert.equal(store.reserved, 0);
});
