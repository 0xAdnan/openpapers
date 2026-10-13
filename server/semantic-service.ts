import { z } from 'zod';
import { S2_ID_PATTERN } from '../shared/providers.ts';
import { CandidatePoolSchema, GraphResponseSchema, PaperResponseSchema, SearchResponseSchema } from '../shared/schemas.ts';
import type { DataMeta, GraphResponse, Paper, SearchResponse } from '../shared/types.ts';
import { PersistentCache } from './cache.ts';
import { buildGraph } from './graph.ts';
import { ApiError, localSearch } from './service.ts';
import { normalizeSemanticPaper, S2_LICENSE_WARNING, S2_SEARCH_WARNING, semanticId, semanticLookup,
  SemanticScholarError, SemanticScholarProvider, type SemanticPaper } from './semantic-scholar.ts';

const s2Papers = (papers: Paper[]) => papers.every(p => S2_ID_PATTERN.test(p.id) && p.references.every(id => S2_ID_PATTERN.test(id)));
const s2Meta = (meta: DataMeta) => meta.provider === 'semantic-scholar' && meta.source !== 'snapshot';
const PoolSchema = CandidatePoolSchema.refine(p => p.provider === 'semantic-scholar' && S2_ID_PATTERN.test(p.origin) && s2Papers(p.papers));
const SearchSchema = SearchResponseSchema.refine(r => s2Meta(r.meta) && s2Papers(r.results) && r.page <= 50);
const PaperSchema = PaperResponseSchema.refine(r => s2Meta(r.meta) && s2Papers([r.paper]));
const GraphSchema = GraphResponseSchema.refine(r => s2Meta(r.meta) && r.origins.every(id => S2_ID_PATTERN.test(id)) &&
  s2Papers([...r.nodes, ...r.prior, ...r.derivative]) && r.edges.every(e => S2_ID_PATTERN.test(e.source) && S2_ID_PATTERN.test(e.target)));
type Pool = z.infer<typeof PoolSchema>;
const unavailable = 'Semantic Scholar unavailable and no matching Semantic Scholar cache exists. Configure server-only S2_API_KEY for official API access, or select OpenAlex for the bundled examples. No OpenAlex data is returned as Semantic Scholar.';
const joinWarnings = (...warnings: (string | undefined)[]) => [...new Set(warnings.filter((w): w is string => !!w))].join(' ');
const deadline = (signal?: AbortSignal) => AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60000)]);

export class SemanticService {
  readonly ready: Promise<void>;
  readonly provider: SemanticScholarProvider;
  private pools = new Map<string, { pool: Pool; expiresAt: number }>();
  private papers = new Map<string, { paper: Paper; meta: DataMeta; expiresAt: number }>();

  constructor(readonly cache: PersistentCache, readonly offline = false, provider?: SemanticScholarProvider) {
    this.provider = provider ?? new SemanticScholarProvider({ cache, offline, apiKey: process.env.S2_API_KEY });
    this.ready = this.load();
  }

  private async load() {
    for (const entry of await this.cache.list<unknown>('s2:pool:v1:')) {
      const p = PoolSchema.safeParse(entry.value);
      if (p.success && entry.key === `s2:pool:v1:${p.data.origin}`) this.rememberPool(p.data, entry.expiresAt);
    }
    for (const entry of await this.cache.list<unknown>('s2:search:v1:')) {
      const r = SearchSchema.safeParse(entry.value);
      if (r.success && entry.key.startsWith(`s2:search:v1:${r.data.page}:`)) this.remember(r.data.results, { ...r.data.meta, source: 'cache' }, entry.expiresAt);
    }
    for (const entry of await this.cache.list<unknown>('s2:paper:v1:')) {
      const r = PaperSchema.safeParse(entry.value);
      if (r.success && entry.key === `s2:paper:v1:${r.data.paper.id}`) this.remember([r.data.paper], { ...r.data.meta, source: 'cache' }, entry.expiresAt);
    }
  }

  private remember(papers: Paper[], meta: DataMeta, expiresAt: number) {
    for (const paper of papers) {
      const previous = this.papers.get(paper.id);
      if (previous && (previous.expiresAt > expiresAt || previous.expiresAt === expiresAt && previous.meta.fetchedAt > meta.fetchedAt)) continue;
      this.papers.delete(paper.id); this.papers.set(paper.id, { paper, meta, expiresAt });
    }
    while (this.papers.size > 4000) this.papers.delete(this.papers.keys().next().value!);
  }

  private rememberPool(pool: Pool, expiresAt: number) {
    this.pools.delete(pool.origin); this.pools.set(pool.origin, { pool, expiresAt });
    while (this.pools.size > 12) this.pools.delete(this.pools.keys().next().value!);
    this.remember(pool.papers, { provider: 'semantic-scholar', source: 'cache', fetchedAt: pool.fetchedAt,
      warning: joinWarnings(pool.coverage, S2_LICENSE_WARNING) }, expiresAt);
  }

  private async cached<T>(key: string, schema: z.ZodType<T>, stale = false) {
    const entry = await this.cache.get<unknown>(key, stale);
    const parsed = entry && schema.safeParse(entry.value);
    return entry && parsed?.success ? { ...entry, value: parsed.data } : undefined;
  }

  private metadata(meta: DataMeta, warning?: string): DataMeta {
    return { ...meta, provider: 'semantic-scholar', warning: joinWarnings(meta.warning, warning, S2_LICENSE_WARNING) };
  }

  private failure(error: unknown): never {
    if (error instanceof ApiError) throw error;
    if (error instanceof SemanticScholarError && error.status === 404) throw new ApiError(404, 'Semantic Scholar paper not found');
    if (error instanceof SemanticScholarError && error.status === 400) throw new ApiError(400, error.message);
    throw new ApiError(503, unavailable);
  }

  async search(q: string, page: number, signal?: AbortSignal): Promise<SearchResponse> {
    signal = deadline(signal);
    await this.ready; signal.throwIfAborted();
    if (!q.trim() || q.length > 200 || /[\x00-\x1f\x7f]/.test(q)) throw new ApiError(400, 'Invalid Semantic Scholar search query');
    q = q.trim();
    if (!Number.isInteger(page) || page < 1 || page > 50) throw new ApiError(400, S2_SEARCH_WARNING);
    const lookup = semanticLookup(q);
    if (/^S2:/i.test(q) && !lookup) throw new ApiError(400, 'Invalid Semantic Scholar ID');
    const key = `s2:search:v1:${page}:${lookup ?? q.toLowerCase()}`;
    const cached = await this.cached(key, SearchSchema, this.offline);
    signal.throwIfAborted();
    if (cached && cached.value.page === page) return { ...cached.value, meta: this.metadata({ ...cached.value.meta, source: 'cache' },
      this.offline ? 'Offline: Semantic Scholar cached matches may be stale.' : undefined) };
    if (!this.offline) try {
      return await this.cache.deduplicate(key, async sharedSignal => {
        const operation = deadline(sharedSignal);
        let results: Paper[], total: number, meta: DataMeta, expiresAt: number;
        if (lookup) {
          const record = await this.provider.getPaper(lookup, operation);
          const paper = normalizeSemanticPaper(record);
          results = page === 1 ? [paper] : []; total = 1;
          meta = this.provider.metadata(record); expiresAt = this.provider.expiresAt(record);
          this.remember([paper], this.metadata(meta), expiresAt);
        } else {
          const remote = await this.provider.search(q, page, operation);
          results = remote.data.map(normalizeSemanticPaper); total = remote.total;
          meta = this.provider.metadata(remote); expiresAt = this.provider.expiresAt(remote);
        }
        operation.throwIfAborted();
        const response: SearchResponse = { results, total, page, perPage: 20, meta: this.metadata(meta,
          joinWarnings(!lookup ? S2_SEARCH_WARNING : undefined, 'Missing references are empty; missing abstracts and indexing gaps can reduce citation evidence.')) };
        this.remember(results, response.meta, expiresAt);
        await this.cache.set(key, response, Math.min(6 * 60 * 60 * 1000, expiresAt - Date.now()));
        operation.throwIfAborted(); return response;
      }, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof SemanticScholarError && error.status === 404) {
        return { results: [], total: 0, page, perPage: 20, meta: this.metadata({ provider: 'semantic-scholar', source: 'live',
          fetchedAt: new Date().toISOString() }, 'Semantic Scholar identifier was not found.') };
      }
      const stale = await this.cached(key, SearchSchema, true);
      signal.throwIfAborted();
      if (stale && stale.value.page === page) return { ...stale.value,
        meta: this.metadata({ ...stale.value.meta, source: 'cache' }, 'Semantic Scholar unavailable; returning stale cached matches.') };
    }
    signal.throwIfAborted();
    if (!this.papers.size) throw new ApiError(503, unavailable);
    const id = lookup && semanticId(lookup);
    const matches = [...this.papers.values()].filter(r => !lookup || (id ? r.paper.id === id : lookup.startsWith('DOI:') &&
      r.paper.doi !== null && semanticLookup(r.paper.doi) === lookup));
    if (lookup && !matches.length) throw new ApiError(503, unavailable);
    const meta = this.metadata({ source: 'cache', fetchedAt: [...this.papers.values()].map(r => r.meta.fetchedAt).sort()[0] },
      `${this.offline ? 'Offline' : 'Semantic Scholar unavailable'}: searching stale/local Semantic Scholar metadata only. Counts are local, not the corpus total.`);
    const response: SearchResponse = lookup ? { results: page === 1 ? matches.slice(0, 1).map(r => r.paper) : [], total: 1, page, perPage: 20, meta }
      : localSearch(matches.map(r => r.paper), q, page, meta);
    if (lookup && !response.total) throw new ApiError(503, unavailable);
    if (response.results.length) response.meta.fetchedAt = response.results.map(p => this.papers.get(p.id)!.meta.fetchedAt).sort()[0];
    response.meta.warning = joinWarnings(response.meta.warning, ...response.results.map(p => this.papers.get(p.id)!.meta.warning));
    return response;
  }

  async paper(id: string, signal?: AbortSignal): Promise<{ paper: Paper; meta: DataMeta }> {
    signal = deadline(signal);
    await this.ready; signal.throwIfAborted();
    if (!S2_ID_PATTERN.test(id)) throw new ApiError(400, 'Use a canonical S2: paper ID');
    const local = this.papers.get(id);
    if (local && (local.expiresAt > Date.now() || this.offline)) return { paper: local.paper,
      meta: this.metadata({ ...local.meta, source: 'cache' }, this.offline ? 'Offline: cached Semantic Scholar metadata may be stale.' : undefined) };
    if (this.offline) throw new ApiError(503, unavailable);
    try {
      return await this.cache.deduplicate(`s2:paper:v1:${id}`, async sharedSignal => {
        const operation = deadline(sharedSignal), record = await this.provider.getPaper(id, operation);
        const paper = normalizeSemanticPaper(record), meta = this.metadata(this.provider.metadata(record),
          record.references == null ? 'References were not returned; references are empty and citation evidence is incomplete.' : 'References are returned IDs only, capped at 2,500.');
        operation.throwIfAborted();
        if (paper.id !== id) throw new SemanticScholarError(502, 'Semantic Scholar paper ID mismatch');
        const expiresAt = this.provider.expiresAt(record);
        this.remember([paper], meta, expiresAt);
        await this.cache.set(`s2:paper:v1:${id}`, { paper, meta }, expiresAt - Date.now());
        operation.throwIfAborted(); return { paper, meta };
      }, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (local && !(error instanceof SemanticScholarError && error.status === 404)) return { paper: local.paper,
        meta: this.metadata({ ...local.meta, source: 'cache' }, 'Semantic Scholar unavailable; returning stale cached metadata.') };
      this.failure(error);
    }
  }

  private async collect(id: string, signal: AbortSignal): Promise<{ pool: Pool; expiresAt: number }> {
    const origin = await this.provider.getPaper(id, signal);
    if (semanticId(origin.paperId) !== id) throw new SemanticScholarError(502, 'Semantic Scholar origin ID mismatch');
    const inputs: object[] = [origin];
    const refs = await this.provider.references(id, signal); inputs.push(refs);
    const citers = await this.provider.citations(id, signal); inputs.push(citers);
    const records = new Map<string, SemanticPaper>([[id, origin]]);
    const sampleIds: string[] = [];
    for (const paper of [...refs.data.map(r => r.citedPaper), ...citers.data.map(r => r.citingPaper)]) {
      if (!paper?.paperId) continue;
      const key = semanticId(paper.paperId)!;
      if (key === id) continue;
      sampleIds.push(key);
      // BasePaper has no outgoing references; batch FullPaper supplies them.
      records.set(key, { ...paper, paperId: paper.paperId });
    }
    const hydrated = await this.provider.batch(sampleIds, signal);
    if (sampleIds.length) inputs.push(hydrated);
    for (const paper of hydrated) records.set(semanticId(paper.paperId)!, paper);
    const common = new Map<string, number>();
    for (const paper of records.values()) for (const reference of new Set(normalizeSemanticPaper(paper).references)) {
      if (!records.has(reference)) common.set(reference, (common.get(reference) ?? 0) + 1);
    }
    const missing = [...common].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, Math.min(100, 300 - records.size)).map(([key]) => key);
    const commonPapers = await this.provider.batch(missing, signal);
    if (missing.length) inputs.push(commonPapers);
    for (const paper of commonPapers) if (records.size < 300) records.set(semanticId(paper.paperId)!, paper);
    signal.throwIfAborted();
    const metadata = inputs.map(input => this.provider.metadata(input));
    const incomplete = [...records.values()].filter(p => p.references == null).length;
    const pool: Pool = { origin: id, provider: 'semantic-scholar', papers: [...records.values()].map(normalizeSemanticPaper),
      fetchedAt: metadata.map(m => m.fetchedAt).sort()[0], source: metadata.some(m => m.source === 'live') ? 'live' : 'cache',
      coverage: `${records.size} fetched candidates: first ${refs.data.length} origin-reference records (limit 80), first ${citers.data.length} citing records (limit 100), batch-hydrated outgoing references, and ${commonPapers.length} common-reference records. API reference/citation order is unspecified, not citation-ranked; this independent sample is not exhaustive. ${incomplete} records have missing references, explicitly represented as empty arrays; unknown/null reference IDs are omitted and outgoing lists are capped at 2,500. Missing abstracts and indexing gaps reduce coverage. Co-citation is sample-local. No recommendation, topic, or direct-citation fallback edges. ${joinWarnings(...metadata.map(m => m.warning), S2_LICENSE_WARNING)}` };
    if (!PoolSchema.safeParse(pool).success) throw new SemanticScholarError(502, 'Invalid Semantic Scholar candidate pool');
    return { pool, expiresAt: Math.min(...inputs.map(input => this.provider.expiresAt(input))) };
  }

  async graph(origins: string[], signal?: AbortSignal): Promise<GraphResponse> {
    signal = deadline(signal);
    await this.ready; signal.throwIfAborted();
    if (!origins.length || origins.length > 3 || new Set(origins).size !== origins.length || origins.some(id => !S2_ID_PATTERN.test(id))) {
      throw new ApiError(400, 'Choose one to three distinct canonical Semantic Scholar S2: IDs');
    }
    origins = [...origins];
    const key = `s2:graph:v1:${origins.join(',')}`;
    const exactOrigins = (graph: GraphResponse) => graph.origins.join(',') === origins.join(',');
    const cached = await this.cached(key, GraphSchema, this.offline);
    signal.throwIfAborted();
    const freshPools = origins.every(id => (this.pools.get(id)?.expiresAt ?? 0) > Date.now());
    if (cached && exactOrigins(cached.value) && (this.offline || freshPools)) return { ...cached.value,
      meta: { ...cached.value.meta, ...this.metadata({ ...cached.value.meta, source: 'cache' }, this.offline ? 'Offline: cached Semantic Scholar graph may be stale.' : undefined) } };
    return this.cache.deduplicate(key, async sharedSignal => {
      const operation = deadline(sharedSignal), groups: { pool: Pool; expiresAt: number }[] = [], warnings: string[] = [];
      let fallback = false;
      for (const id of origins) {
        operation.throwIfAborted();
        const exact = this.pools.get(id);
        if (exact && exact.expiresAt > Date.now()) { groups.push({ ...exact, pool: { ...exact.pool, source: 'cache' } }); continue; }
        if (!this.offline) try {
          const acquired = await this.cache.deduplicate(`s2:pool:v1:${id}`, shared => this.collect(id, deadline(shared)), operation);
          operation.throwIfAborted();
          this.rememberPool(acquired.pool, acquired.expiresAt);
          await this.cache.set(`s2:pool:v1:${id}`, acquired.pool, acquired.expiresAt - Date.now());
          groups.push(acquired); continue;
        } catch (error) {
          operation.throwIfAborted();
          if (error instanceof SemanticScholarError && error.status === 404) this.failure(error);
          const stale = await this.cached(key, GraphSchema, true);
          operation.throwIfAborted();
          if (stale && exactOrigins(stale.value)) return { ...stale.value, meta: { ...stale.value.meta,
            ...this.metadata({ ...stale.value.meta, source: 'cache' }, 'Semantic Scholar unavailable; returning a stale cached graph.') } };
        }
        fallback = true;
        const reason = this.offline ? 'Offline' : 'Semantic Scholar unavailable';
        warnings.push(`${reason}: stale/local data used for ${id}; no fresh origin-specific expansion.`);
        if (exact) { groups.push({ ...exact, pool: { ...exact.pool, source: 'cache' } }); continue; }
        const containing = [...this.pools.values()].filter(g => g.pool.papers.some(p => p.id === id));
        if (containing.length) {
          groups.push(...containing.map(g => ({ ...g, pool: { ...g.pool, source: 'cache' as const,
            coverage: `Containing pool for ${g.pool.origin}, not an expanded neighborhood for ${id}; no origin-specific neighborhood was fetched. ${g.pool.coverage}` } })));
        } else {
          const local = this.papers.get(id);
          if (!local) throw new ApiError(503, unavailable);
          groups.push({ expiresAt: local.expiresAt, pool: { origin: id, provider: 'semantic-scholar', papers: [local.paper],
            fetchedAt: local.meta.fetchedAt, source: 'cache', coverage: `Only cached origin metadata; no expanded neighborhood was fetched. ${local.meta.warning ?? ''}` } });
        }
      }
      operation.throwIfAborted();
      const papers = [...new Map(groups.flatMap(g => g.pool.papers).map(p => [p.id, p])).values()];
      const bounded = [...origins.map(id => papers.find(p => p.id === id)!), ...papers.filter(p => !origins.includes(p.id))].slice(0, 900);
      const response = buildGraph(bounded, origins, { provider: 'semantic-scholar',
        source: groups.some(g => g.pool.source === 'live') ? 'live' : 'cache', fetchedAt: groups.map(g => g.pool.fetchedAt).sort()[0],
        candidateCount: bounded.length, algorithm: '', coverage: [...new Set(groups.map(g => g.pool.coverage))].join(' '),
        warning: joinWarnings(...warnings, 'Sampled Semantic Scholar data, not an exhaustive literature map. Co-citation is sample-local; an absent edge does not establish unrelatedness.', S2_LICENSE_WARNING) });
      operation.throwIfAborted();
      await this.cache.set(key, response, fallback ? -1 : Math.min(...groups.map(g => g.expiresAt)) - Date.now());
      operation.throwIfAborted(); return response;
    }, signal).catch(error => { signal.throwIfAborted(); this.failure(error); });
  }
}
