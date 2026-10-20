import { z } from 'zod';
import { S2_ID_PATTERN } from '../shared/providers.ts';
import { CandidatePoolSchema, GraphResponseSchema, PaperResponseSchema, SearchResponseSchema } from '../shared/schemas.ts';
import type { DataMeta, GraphResponse, Paper, SearchResponse } from '../shared/types.ts';
import { PersistentCache, staleAge } from './cache.ts';
import { ALGORITHM, buildGraph } from './graph.ts';
import { ApiError, localSearch } from './service.ts';
import { normalizeSemanticPaper, S2_LICENSE_WARNING, S2_SEARCH_WARNING, semanticId, semanticLookup,
  SemanticScholarError, SemanticScholarProvider, type SemanticPaper } from './semantic-scholar.ts';

const s2Papers = (papers: Paper[]) => papers.every(p => S2_ID_PATTERN.test(p.id) && p.references.every(id => S2_ID_PATTERN.test(id)));
const s2Meta = (meta: DataMeta) => meta.provider === 'semantic-scholar' && meta.source !== 'snapshot';
const PoolSchema = CandidatePoolSchema.safeExtend({ warning: z.string().optional() })
  .refine(p => p.provider === 'semantic-scholar' && S2_ID_PATTERN.test(p.origin) && s2Papers(p.papers));
const SearchSchema = SearchResponseSchema.refine(r => s2Meta(r.meta) && s2Papers(r.results) && r.page <= 50);
const PaperSchema = PaperResponseSchema.refine(r => s2Meta(r.meta) && s2Papers([r.paper]));
const GraphSchema = GraphResponseSchema.refine(r => s2Meta(r.meta) && r.origins.every(id => S2_ID_PATTERN.test(id)) &&
  s2Papers([...r.nodes, ...r.prior, ...r.derivative]) && r.edges.every(e => S2_ID_PATTERN.test(e.source) && S2_ID_PATTERN.test(e.target)));
type Pool = z.infer<typeof PoolSchema>;
const unavailable = 'Semantic Scholar is unavailable and no matching Semantic Scholar cache exists. Configure server-only S2_API_KEY for official API access. No other data is substituted for Semantic Scholar results.';
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
      warning: joinWarnings(pool.warning, S2_LICENSE_WARNING) }, expiresAt);
  }

  private async cached<T>(key: string, schema: z.ZodType<T>, stale = false) {
    const entry = await this.cache.get<unknown>(key, stale);
    const parsed = entry && schema.safeParse(entry.value);
    return entry && parsed?.success ? { ...entry, value: parsed.data } : undefined;
  }

  private metadata(meta: DataMeta, warning?: string): DataMeta {
    return { ...meta, provider: 'semantic-scholar', warning: joinWarnings(meta.warning, warning,
      [meta.warning, warning].some(w => w?.includes(S2_LICENSE_WARNING)) ? undefined : S2_LICENSE_WARNING) };
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
    const originPaper = normalizeSemanticPaper(origin);
    const inputs: object[] = [origin];
    const warnings: string[] = [];
    let cooldownUntil = 0;
    const acquire = async <T extends object>(label: string, fetch: () => Promise<T>): Promise<T | undefined> => {
      signal.throwIfAborted();
      if (Date.now() < cooldownUntil) {
        warnings.push(`${label} skipped during Semantic Scholar rate-limit cooldown.`);
        return undefined;
      }
      try {
        const result = await fetch();
        signal.throwIfAborted(); inputs.push(result);
        return result;
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof SemanticScholarError && error.status === 429) {
          const retryAfter = Math.max(60, Number.isFinite(error.retryAfter) ? error.retryAfter! : 60);
          cooldownUntil = Date.now() + retryAfter * 1000;
          warnings.push(`${label} unavailable: Semantic Scholar rate limited; retry after ${Math.ceil(retryAfter)} seconds.`);
        } else warnings.push(`${label} unavailable; successfully acquired metadata was retained.`);
        return undefined;
      }
    };
    const records = new Map<string, SemanticPaper>([[id, origin]]);
    let skipped = 0;
    const refs = await acquire('references endpoint', () => this.provider.references(id, signal));
    const referenceIds = refs ? [...new Set(refs.data.flatMap(({ citedPaper: paper }) => {
      const key = semanticId(paper?.paperId);
      if (!key || key === id) return [];
      // BasePaper has no outgoing references; retain it if FullPaper hydration fails.
      if (paper!.title?.trim()) records.set(key, { ...paper!, paperId: paper!.paperId! });
      else skipped++;
      return [key];
    }))] : originPaper.references.slice(0, 80);
    // The endpoint observes these citations even when target metadata is unusable.
    // Clone the origin, leaving raw-cache data and returned-object provenance intact.
    if (refs) records.set(id, { ...origin, references: [...new Set([...originPaper.references, ...referenceIds])]
      .map(key => ({ paperId: key.slice(3) })) });
    const hydrate = async (ids: string[], label: string): Promise<SemanticPaper[]> => {
      if (!ids.length) return [];
      const hydrated = await acquire(label, () => this.provider.batch(ids, signal));
      if (!hydrated) return [];
      const usable = hydrated.filter(paper => {
        if (paper.title?.trim()) return true;
        skipped++; return false;
      });
      for (const paper of usable) if (records.has(semanticId(paper.paperId)!) || records.size < 300) records.set(semanticId(paper.paperId)!, paper);
      const returned = new Set(hydrated.map(p => semanticId(p.paperId)!));
      const missing = ids.filter(key => !returned.has(key)).length;
      if (missing) warnings.push(`${label}: ${missing} requested records were not returned; missing metadata was not invented.`);
      return usable;
    };
    // Preserve usable reference evidence before the optional citations endpoint can rate-limit.
    const hydratedReferences = await hydrate(referenceIds, 'reference hydration');
    const citers = await acquire('citations endpoint', () => this.provider.citations(id, signal));
    const citerIds = citers ? [...new Set(citers.data.flatMap(({ citingPaper: paper }) => {
      const key = semanticId(paper?.paperId);
      if (!key || key === id) return [];
      if (!paper!.title?.trim()) skipped++;
      else if (!records.has(key)) records.set(key, { ...paper!, paperId: paper!.paperId! });
      return [key];
    }))] : [];
    const hydratedCiters = await hydrate(citerIds.filter(key => records.get(key)?.references == null), 'citing-paper hydration');
    const common = new Map<string, number>();
    for (const paper of records.values()) for (const reference of new Set(normalizeSemanticPaper(paper).references)) {
      if (!records.has(reference)) common.set(reference, (common.get(reference) ?? 0) + 1);
    }
    const missing = [...common].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, Math.min(100, 300 - records.size)).map(([key]) => key);
    const commonPapers = await hydrate(missing, 'common-reference hydration');
    signal.throwIfAborted();
    if (skipped) warnings.push(`${skipped} optional records with missing or blank titles were skipped; paper metadata was not invented.`);
    const metadata = inputs.map(input => this.provider.metadata(input));
    const incomplete = [...records.values()].filter(p => p.references == null).length;
    const pool: Pool = { origin: id, provider: 'semantic-scholar', papers: [...records.values()].map(normalizeSemanticPaper),
      fetchedAt: metadata.map(m => m.fetchedAt).sort()[0], source: metadata.some(m => m.source === 'live') ? 'live' : 'cache',
      ...(warnings.length ? { warning: `Partial Semantic Scholar acquisition: ${joinWarnings(...warnings)}` } : {}),
      coverage: `${records.size} fetched candidates: ${refs ? `first ${refs.data.length} origin-reference records (limit 80; ${referenceIds.length} usable unique IDs)` : `references endpoint unavailable; first ${referenceIds.length} origin-returned reference IDs (limit 80)`}, ${citers ? `first ${citers.data.length} citing records (limit 100; ${citerIds.length} usable unique IDs)` : 'citing records were not fetched; the origin citation count is not an observed citer sample'}, ${hydratedReferences.length} reference and ${hydratedCiters.length} citing batch-hydrated records, and ${commonPapers.length} common-reference records. API reference/citation order is unspecified, not citation-ranked; this independent sample is not exhaustive. ${incomplete} records have missing references, explicitly represented as empty arrays; unknown/null reference IDs are omitted and outgoing lists are capped at 2,500. Origin references combine returned IDs with observed references-endpoint IDs, even when target metadata is unusable. Missing abstracts and indexing gaps reduce coverage. Co-citation is sample-local, derived only from acquired outgoing reference lists${!citers ? ', including reference papers, not a fetched origin-citer sample' : ''}. Similarity edges require shared-reference or sampled co-citation evidence; separately marked zero-weight direct-citation links provide citation context only. No recommendation or topic scores create edges. ${joinWarnings(...warnings, ...metadata.map(m => m.warning), S2_LICENSE_WARNING)}` };
    if (!PoolSchema.safeParse(pool).success) throw new SemanticScholarError(502, 'Invalid Semantic Scholar candidate pool');
    const now = Date.now();
    const partialExpiry = warnings.length ? (cooldownUntil > now ? Math.min(cooldownUntil, now + 60 * 60 * 1000) : now + 5 * 60 * 1000) : Infinity;
    return { pool, expiresAt: Math.min(partialExpiry, ...inputs.map(input => this.provider.expiresAt(input))) };
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
    if (cached && cached.value.meta.algorithm === ALGORITHM && exactOrigins(cached.value) && (this.offline || freshPools)) return { ...cached.value,
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
          const age = stale && staleAge(stale.value.meta.fetchedAt);
          if (stale && age && exactOrigins(stale.value)) return { ...stale.value, meta: { ...stale.value.meta,
            ...this.metadata({ ...stale.value.meta, source: 'cache' }, `Semantic Scholar unavailable; returning a stale cached graph whose data is ${age}.`) } };
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
        warning: joinWarnings(...warnings, ...groups.map(g => g.pool.warning), 'Sampled Semantic Scholar data, not an exhaustive literature map. Co-citation is sample-local; an absent edge does not establish unrelatedness.', S2_LICENSE_WARNING) });
      operation.throwIfAborted();
      await this.cache.set(key, response, fallback ? -1 : Math.min(...groups.map(g => g.expiresAt)) - Date.now());
      operation.throwIfAborted(); return response;
    }, signal).catch(error => { signal.throwIfAborted(); this.failure(error); });
  }
}
