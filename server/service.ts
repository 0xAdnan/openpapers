import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import type { DataMeta, Example, GraphResponse, Paper, SearchResponse } from '../shared/types.ts';
import { PersistentCache } from './cache.ts';
import { collectCandidates, type CandidatePool } from './collection.ts';
import { buildGraph } from './graph.ts';
import { SEEDS, auditedConflict, seedConflict } from './integrity.ts';
import { ID_PATTERN, normalizeWork, OpenAlexProvider, ProviderError, workId } from './openalex.ts';
import { CandidatePoolSchema as SharedCandidatePoolSchema, GraphResponseSchema as SharedGraphResponseSchema,
  PaperResponseSchema as SharedPaperResponseSchema, SearchResponseSchema as SharedSearchResponseSchema } from '../shared/schemas.ts';

const oaPapers = (papers: Paper[]) => papers.every(p => ID_PATTERN.test(p.id) && p.references.every(id => ID_PATTERN.test(id)));
// Bundled snapshots and persisted OpenAlex entries predate explicit provider metadata.
const oaMeta = (meta: Pick<DataMeta, 'provider'>) => meta.provider === undefined || meta.provider === 'openalex';
const CandidatePoolSchema = SharedCandidatePoolSchema.refine(p => oaMeta(p) && ID_PATTERN.test(p.origin) && oaPapers(p.papers));
const SearchResponseSchema = SharedSearchResponseSchema.refine(r => oaMeta(r.meta) && oaPapers(r.results));
const PaperResponseSchema = SharedPaperResponseSchema.refine(r => oaMeta(r.meta) && oaPapers([r.paper]));
const GraphResponseSchema = SharedGraphResponseSchema.refine(r => oaMeta(r.meta) && r.origins.every(id => ID_PATTERN.test(id)) &&
  oaPapers([...r.nodes, ...r.prior, ...r.derivative]) && r.edges.every(e => ID_PATTERN.test(e.source) && ID_PATTERN.test(e.target)));

interface Snapshot {
  version: number;
  provider: string;
  fetchedAt: string;
  examples: Example[];
  identifiers: Record<string, string>;
  groups: CandidatePool[];
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function localSearch(papers: Paper[], q: string, page: number, meta: DataMeta): SearchResponse {
  const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const query = normalize(q);
  const tokens = query.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const doi = query.replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
  const id = workId(q);
  const ranked = [...new Map(papers.map(p => [p.id, p])).values()].map(p => {
    const title = normalize(p.title);
    const text = normalize([p.title, ...p.authors, ...p.topics, p.abstract, p.doi ?? '', p.id].join(' '));
    let score = tokens.length && tokens.every(token => text.includes(token)) ? 1 : 0;
    if (title.includes(query)) score += 10;
    if (title === query) score += 100;
    if (id === p.id || p.doi?.toLowerCase().replace(/^https?:\/\/doi\.org\//, '') === doi) score += 200;
    return { p, score };
  }).filter(row => row.score > 0).sort((a, b) => b.score - a.score || b.p.citations - a.p.citations || a.p.id.localeCompare(b.p.id));
  return { results: ranked.slice((page - 1) * 20, page * 20).map(row => row.p), total: ranked.length, page, perPage: 20, meta };
}

export class PaperService {
  private snapshot!: Snapshot;
  private pools: CandidatePool[] = [];
  private poolExpiry = new Map<string, number>();
  private papers = new Map<string, Paper>();
  private paperMeta = new Map<string, DataMeta>();
  private paperExpiry = new Map<string, number>();
  readonly ready: Promise<void>;
  readonly provider: OpenAlexProvider;

  constructor(readonly cache: PersistentCache, readonly offline = false, provider?: OpenAlexProvider,
    snapshotPath = fileURLToPath(new URL('../data/snapshot.json', import.meta.url))) {
    this.provider = provider ?? new OpenAlexProvider({ cache, offline, apiKey: process.env.OPENALEX_API_KEY });
    this.ready = this.load(snapshotPath);
  }

  private async load(path: string) {
    if ((await stat(path)).size > 24 * 1024 * 1024) throw new Error('Snapshot exceeds size limit');
    const snapshot: Snapshot = JSON.parse(await readFile(path, 'utf8'));
    if (snapshot.version !== 1 || snapshot.provider !== 'https://api.openalex.org' ||
        !Array.isArray(snapshot.groups) || snapshot.groups.length !== 3 || !Array.isArray(snapshot.examples)) {
      throw new Error('Invalid bundled snapshot');
    }
    this.snapshot = snapshot;
    for (const group of snapshot.groups) {
      if (!CandidatePoolSchema.safeParse(group).success) throw new Error('Invalid snapshot candidate pool');
      this.remember(group.papers, { source: 'snapshot', fetchedAt: group.fetchedAt });
    }
    for (const entry of await this.cache.list<unknown>('pool:')) {
      const parsed = CandidatePoolSchema.safeParse(entry.value);
      if (parsed.success && entry.key === `pool:${parsed.data.origin}`) {
        this.pools.push(parsed.data);
        this.poolExpiry.set(parsed.data.origin, entry.expiresAt);
        this.remember(parsed.data.papers, { source: 'cache', fetchedAt: parsed.data.fetchedAt }, entry.expiresAt);
      }
    }
    for (const entry of await this.cache.list<unknown>('search:')) {
      const parsed = SearchResponseSchema.safeParse(entry.value);
      if (parsed.success) this.remember(parsed.data.results, { ...parsed.data.meta, source: 'cache' }, entry.expiresAt);
    }
    for (const entry of await this.cache.list<unknown>('paper:')) {
      const parsed = PaperResponseSchema.safeParse(entry.value);
      if (parsed.success && entry.key === `paper:${parsed.data.paper.id}`) this.remember([parsed.data.paper], { ...parsed.data.meta, source: 'cache' }, entry.expiresAt);
    }
    this.pools = this.pools.slice(-12);
    this.poolExpiry = new Map(this.pools.map(pool => [pool.origin, this.poolExpiry.get(pool.origin)!]));
  }

  private remember(papers: Paper[], meta: DataMeta, expiresAt = 0) {
    if (!oaMeta(meta)) return;
    meta = { ...meta, provider: 'openalex' };
    for (const paper of papers) if (oaPapers([paper])) {
      if ((this.paperExpiry.get(paper.id) ?? 0) > expiresAt) continue;
      this.papers.set(paper.id, paper);
      this.paperMeta.set(paper.id, meta);
      this.paperExpiry.set(paper.id, expiresAt);
    }
    while (this.papers.size > 4000) {
      const protectedIds = new Set(this.snapshot.groups.flatMap(g => g.papers.map(p => p.id)));
      const removable = [...this.papers.keys()].find(id => !protectedIds.has(id));
      if (!removable) break;
      this.papers.delete(removable);
      this.paperMeta.delete(removable);
      this.paperExpiry.delete(removable);
    }
  }

  async examples() {
    await this.ready;
    return this.snapshot.examples.map(example => {
      const paper = this.papers.get(example.id);
      const warning = paper && this.integrityMeta<DataMeta>({ source: 'snapshot', fetchedAt: this.snapshot.fetchedAt }, [paper]).warning;
      return warning ? { ...example, warning } : example;
    });
  }

  private async cached<T>(key: string, schema: z.ZodType<T>, stale = false) {
    const entry = await this.cache.get<unknown>(key, stale);
    if (!entry) return undefined;
    const parsed = schema.safeParse(entry.value);
    return parsed.success ? { ...entry, value: parsed.data } : undefined;
  }

  private integrityMeta<T extends DataMeta>(meta: T, papers: Paper[], query?: string): T {
    meta = { ...meta, provider: 'openalex' };
    const doiQuery = query?.toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
    const warnings = new Set<string>();
    for (const paper of papers) {
      const conflict = auditedConflict(paper);
      if (conflict && !meta.warning?.includes(conflict)) warnings.add(conflict);
    }
    for (const seed of SEEDS) {
      const seedDoi = seed.doi.toLowerCase();
      for (const paper of papers) {
        if (paper.id !== this.snapshot.identifiers[seedDoi] && doiQuery !== seedDoi) continue;
        const conflict = seedConflict(paper, seed);
        if (conflict && !meta.warning?.includes(conflict)) warnings.add(conflict);
      }
    }
    return warnings.size ? { ...meta, warning: [meta.warning, ...warnings].filter(Boolean).join(' ') } : meta;
  }

  async search(q: string, page: number, signal?: AbortSignal): Promise<SearchResponse> {
    signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60000)]);
    await this.ready;
    signal.throwIfAborted();
    const key = `search:${page}:${q.toLowerCase()}`;
    const cached = await this.cached(key, SearchResponseSchema, this.offline);
    if (cached) return { ...cached.value, meta: this.integrityMeta({ ...cached.value.meta, source: 'cache',
      ...(this.offline ? { warning: [cached.value.meta.warning, 'Offline: cached OpenAlex search results may be stale.'].filter(Boolean).join(' ') } : {}) }, cached.value.results, q) };
    if (!this.offline) {
      try {
        return await this.cache.deduplicate(key, async sharedSignal => {
          const operationSignal = AbortSignal.any([sharedSignal, AbortSignal.timeout(60000)]);
          const id = workId(q);
          const remote = id ? { results: page === 1 ? [await this.provider.getPaper(id, operationSignal)] : [], meta: { count: 1 } } : await this.provider.search(q, page, operationSignal);
          operationSignal.throwIfAborted();
          const results = remote.results.map(normalizeWork);
          const meta = this.integrityMeta(this.provider.metadata(id && remote.results[0] ? remote.results[0] : remote), results, q);
          this.remember(results, meta, Date.now() + 6 * 60 * 60 * 1000);
          const response: SearchResponse = { results, total: remote.meta.count, page, perPage: 20,
            meta };
          await this.cache.set(key, response, 6 * 60 * 60 * 1000);
          return response;
        }, signal);
      } catch {
        signal.throwIfAborted();
        const stale = await this.cached(key, SearchResponseSchema, true);
        if (stale) return { ...stale.value, meta: this.integrityMeta({ ...stale.value.meta, source: 'cache', warning: [stale.value.meta.warning, 'OpenAlex unavailable; returning stale cached matches.'].filter(Boolean).join(' ') }, stale.value.results, q) };
      }
    }
    const doiQuery = q.toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
    const response = localSearch([...this.papers.values()], this.snapshot.identifiers[doiQuery] ?? q, page, {
      source: this.pools.length ? 'cache' : 'snapshot', fetchedAt: this.snapshot.fetchedAt,
      warning: `${this.offline ? 'Offline mode' : 'OpenAlex unavailable'}: searching bundled and previously cached metadata only. Result counts are local, not the full OpenAlex corpus.`,
    });
    return { ...response, meta: this.integrityMeta(response.meta, response.results, q) };
  }

  async paper(id: string, signal?: AbortSignal): Promise<{ paper: Paper; meta: DataMeta }> {
    signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60000)]);
    await this.ready;
    signal.throwIfAborted();
    const local = this.papers.get(id);
    const localMeta = this.paperMeta.get(id);
    const fresh = (this.paperExpiry.get(id) ?? 0) > Date.now();
    if (local && (fresh || this.offline)) return { paper: local, meta: this.integrityMeta({ ...localMeta!,
      ...(this.offline ? { warning: [localMeta?.warning, 'Offline: local OpenAlex metadata may be stale.'].filter(Boolean).join(' ') } : {}) }, [local]) };
    if (this.offline) throw new ApiError(404, 'Paper is not available in the offline collection');
    try {
      const record = await this.provider.getPaper(id, signal);
      signal.throwIfAborted();
      const paper = normalizeWork(record), meta = this.integrityMeta(this.provider.metadata(record), [paper]);
      this.remember([paper], meta, Date.now() + 24 * 60 * 60 * 1000);
      await this.cache.set(`paper:${id}`, { paper, meta });
      return { paper, meta };
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ProviderError && error.status === 404) throw new ApiError(404, 'OpenAlex paper not found');
      if (local) return { paper: local, meta: this.integrityMeta({ ...localMeta!,
        warning: [localMeta?.warning, 'OpenAlex unavailable; returning stale local metadata.'].filter(Boolean).join(' ') }, [local]) };
      throw new ApiError(503, 'OpenAlex unavailable and this paper is not cached');
    }
  }

  async graph(origins: string[], signal?: AbortSignal): Promise<GraphResponse> {
    signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60000)]);
    await this.ready;
    signal.throwIfAborted();
    const key = `graph:v1:${origins.join(',')}`;
    const cached = await this.cached(key, GraphResponseSchema, this.offline);
    const freshPools = origins.every(id => this.pools.some(g => g.origin === id && (this.poolExpiry.get(id) ?? 0) > Date.now()));
    if (cached && (this.offline || freshPools) && cached.value.origins.join(',') === origins.join(',')) return { ...cached.value, origins, meta: this.integrityMeta({ ...cached.value.meta, source: 'cache',
      ...(this.offline ? { warning: [cached.value.meta.warning, 'Offline: cached graph may be stale.'].filter(Boolean).join(' ') } : {}) }, [...cached.value.nodes, ...cached.value.prior, ...cached.value.derivative]) };
    return this.cache.deduplicate(key, async sharedSignal => {
      const operationSignal = AbortSignal.any([sharedSignal, AbortSignal.timeout(60000)]);
      const groups: CandidatePool[] = [];
      const snapshotGroups = new Set(this.snapshot.groups);
      let live = false;
      let fallback = false;
      const fallbackWarnings: string[] = [];
      for (const id of origins) {
        operationSignal.throwIfAborted();
        const exact = this.pools.find(g => g.origin === id && (this.poolExpiry.get(id) ?? 0) > Date.now());
        if (exact) { groups.push({ ...exact, source: 'cache' }); continue; }
        if (!this.offline) try {
          const origin = await this.provider.getPaper(id, operationSignal);
          const group = await collectCandidates(this.provider, origin, operationSignal);
          operationSignal.throwIfAborted();
          groups.push(group);
          this.pools = this.pools.filter(g => g.origin !== id);
          this.pools.push(group);
          this.pools = this.pools.slice(-12);
          this.poolExpiry.set(id, Date.now() + 7 * 24 * 60 * 60 * 1000);
          this.poolExpiry = new Map(this.pools.map(pool => [pool.origin, this.poolExpiry.get(pool.origin)!]));
          this.remember(group.papers, { source: group.source, fetchedAt: group.fetchedAt }, this.poolExpiry.get(id));
          await this.cache.set(`pool:${id}`, group, 7 * 24 * 60 * 60 * 1000);
          live ||= group.source === 'live';
          continue;
        } catch (error) {
          operationSignal.throwIfAborted();
          if (error instanceof ProviderError && error.status === 404) throw new ApiError(404, `OpenAlex paper ${id} not found`);
          const stale = await this.cached(key, GraphResponseSchema, true);
          if (stale && stale.value.origins.join(',') === origins.join(',')) return { ...stale.value, meta: this.integrityMeta({ ...stale.value.meta, source: 'cache', warning: [stale.value.meta.warning, 'OpenAlex unavailable; returning a stale cached graph.'].filter(Boolean).join(' ') }, [...stale.value.nodes, ...stale.value.prior, ...stale.value.derivative]) };
        }
        fallback = true;
        const reason = this.offline ? 'Offline mode' : 'OpenAlex unavailable';
        fallbackWarnings.push(`${reason}; using stale local data for ${id}.`);
        const local = [...this.pools, ...this.snapshot.groups].filter(g => g.papers.some(p => p.id === id));
        const exactLocal = local.find(g => g.origin === id);
        if (exactLocal) {
          groups.push(this.snapshot.groups.includes(exactLocal) ? exactLocal : { ...exactLocal, source: 'cache' });
        } else if (local.length) {
          groups.push(...local.map(g => {
            const fallbackGroup = { ...g, coverage: `Local containing pool for ${g.origin}, not an expanded neighborhood for ${id}; no origin-specific neighborhood was fetched. ${g.coverage}` };
            if (snapshotGroups.has(g)) snapshotGroups.add(fallbackGroup);
            return fallbackGroup;
          }));
        } else {
          if (!this.papers.has(id)) throw new ApiError(this.offline ? 404 : 503, this.offline
            ? `Paper ${id} is not available in the offline collection` : 'OpenAlex unavailable; this origin has no local graph data');
          const papers = [this.papers.get(id)!, ...[...this.papers.values()].filter(p => p.id !== id)].slice(0, 900);
          groups.push({ origin: id, papers, fetchedAt: papers.map(p => this.paperMeta.get(p.id)!.fetchedAt).sort()[0], source: 'cache',
            coverage: `${reason}; graph uses locally cached metadata only; no expanded origin-specific neighborhood was fetched.` });
        }
      }
      const uniqueGroups = [...new Set(groups)];
      const papers = [...new Map(uniqueGroups.flatMap(g => g.papers).map(p => [p.id, p])).values()];
      // Keep all requested origins even when unioned cached neighborhoods exceed the cap.
      const bounded = [...origins.map(id => papers.find(p => p.id === id)!).filter(Boolean), ...papers.filter(p => !origins.includes(p.id))].slice(0, 900);
      const response = buildGraph(bounded, origins, this.integrityMeta({
        source: live ? 'live' : uniqueGroups.every(g => snapshotGroups.has(g)) ? 'snapshot' : 'cache',
        fetchedAt: uniqueGroups.map(g => g.fetchedAt).sort()[0], candidateCount: bounded.length, algorithm: '',
        coverage: [...new Set(uniqueGroups.map(g => g.coverage))].join(' '),
        warning: [...fallbackWarnings, 'Sampled OpenAlex data, not an exhaustive literature map. Co-citation counts are sample-local; an absent edge does not establish unrelatedness.'].join(' '),
      }, bounded));
      operationSignal.throwIfAborted();
      const expiresAt = Math.min(...origins.map(id => this.poolExpiry.get(id) ?? 0));
      // Offline/outage responses remain stale; rebuilding does not renew their inputs.
      await this.cache.set(key, response, fallback ? -1 : Math.max(0, expiresAt - Date.now()));
      return response;
    }, signal);
  }
}
