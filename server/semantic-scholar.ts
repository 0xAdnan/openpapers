import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DataMeta, Paper } from '../shared/types.ts';
import { PersistentCache } from './cache.ts';
import { createSemanticRateLimiter, semanticRetryAfter, SemanticRateLimitError,
  type SemanticRateLimiter, type SemanticRateReservation } from './semantic-rate-limit.ts';

export const S2_ORIGIN = 'https://api.semanticscholar.org';
export const S2_FIELDS = 'title,authors,year,venue,citationCount,referenceCount,abstract,externalIds,url,openAccessPdf,isOpenAccess,fieldsOfStudy';
export const S2_FULL_FIELDS = `${S2_FIELDS},references.paperId`;
export const S2_LICENSE_WARNING = 'Semantic Scholar official API terms and underlying data licenses apply; this data is not blanket CC0. No Semantic Scholar data bundle is redistributed.';
export const S2_SEARCH_WARNING = 'Semantic Scholar total is the upstream approximate match count. Only the first 1,000 relevance-ranked results are accessible (pages 1-50); narrow your query for more results. See https://api.semanticscholar.org/api-docs/graph.';

const hex = /^[a-f0-9]{40}$/i;
const doiPattern = /^10\.\d{4,9}\/[^\s\x00-\x1f\x7f]+$/i;
const arxivPattern = /^(?:\d{4}\.\d{4,5}|[a-z][a-z.-]*(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i;

export class SemanticScholarError extends Error {
  constructor(public status: number, message = 'Semantic Scholar is unavailable', public retryAfter?: number) { super(message); }
}

export function semanticId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.replace(/^S2:/i, '');
  return hex.test(raw) ? `S2:${raw.toLowerCase()}` : null;
}

// URLs are parsed as identifiers only, never used as transport destinations.
export function semanticLookup(value: string): string | null {
  const q = value.trim();
  if (!q || q.length > 2000 || /[\x00-\x1f\x7f]/.test(value)) return null;
  const id = semanticId(q);
  if (id) return id.slice(3);
  let alias = q;
  if (/^https?:\/\//i.test(q)) {
    try {
      const url = new URL(q);
      if (url.username || url.password || url.port || url.search || url.hash) return null;
      if (['semanticscholar.org', 'www.semanticscholar.org'].includes(url.hostname)) {
        const match = url.pathname.match(/^\/paper\/(?:[^/]+\/)?([a-f0-9]{40})\/?$/i);
        return match ? match[1].toLowerCase() : null;
      }
      if (['doi.org', 'dx.doi.org'].includes(url.hostname)) alias = decodeURIComponent(url.pathname.slice(1));
      else if (['arxiv.org', 'www.arxiv.org'].includes(url.hostname) && /^\/(?:abs|pdf)\//.test(url.pathname)) {
        alias = `ARXIV:${url.pathname.replace(/^\/(?:abs|pdf)\//, '').replace(/\.pdf$/, '')}`;
      } else return null;
    } catch { return null; }
  }
  const doi = alias.replace(/^DOI:/i, '');
  if (doiPattern.test(doi)) return `DOI:${doi.toLowerCase()}`;
  const arxiv = alias.replace(/^ARXIV:/i, '');
  return arxivPattern.test(arxiv) ? `ARXIV:${arxiv.replace(/v\d+$/i, '')}` : null;
}

const text = z.string().max(200000).nullish();
const count = z.number().int().nonnegative().nullish();
const rawId = z.string().regex(hex);
const RawPaperSchema = z.object({
  paperId: rawId,
  title: text, abstract: text, venue: text, url: text,
  year: z.number().int().nullish(), citationCount: count, referenceCount: count,
  authors: z.array(z.object({ name: text })).max(10000).nullish(),
  externalIds: z.object({ DOI: text, ArXiv: text }).nullish(),
  openAccessPdf: z.object({ url: text, status: text, license: text, disclaimer: text }).nullish(),
  isOpenAccess: z.boolean().nullish(),
  fieldsOfStudy: z.array(z.string().max(2000)).max(100).nullish(),
  references: z.array(z.object({ paperId: rawId.nullable() })).max(100000).nullish(),
});
export type SemanticPaper = z.infer<typeof RawPaperSchema>;
const SearchSchema = z.object({ total: z.number().int().nonnegative(), offset: z.number().int().nonnegative(),
  next: z.number().int().nonnegative().optional(), data: z.array(RawPaperSchema).max(20) });
export type SemanticSearchPage = z.infer<typeof SearchSchema>;
const linkPaper = RawPaperSchema.extend({ paperId: rawId.nullable() });
const pagination = { offset: z.number().int().nonnegative(), next: z.number().int().nonnegative().optional() };
const ReferenceSchema = z.object({ ...pagination, data: z.array(z.object({ citedPaper: linkPaper.nullable() })).max(100) });
const CitationSchema = z.object({ ...pagination, data: z.array(z.object({ citingPaper: linkPaper.nullable() })).max(100) });
const BatchSchema = z.array(RawPaperSchema.nullable()).max(100);
const MetaSchema = z.object({ provider: z.literal('semantic-scholar'), source: z.enum(['live', 'cache']),
  fetchedAt: z.string().refine(s => Number.isFinite(Date.parse(s))), warning: z.string().optional() });

function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function normalizeSemanticPaper(value: SemanticPaper): Paper {
  const parsed = RawPaperSchema.safeParse(value);
  if (!parsed.success || !parsed.data.title?.trim()) throw new SemanticScholarError(502, 'Invalid Semantic Scholar paper metadata');
  const p = parsed.data, id = semanticId(p.paperId)!;
  const doi = p.externalIds?.DOI;
  return {
    id, title: p.title!.slice(0, 2000), authors: (p.authors ?? []).slice(0, 100).flatMap(a => a.name ? [a.name.slice(0, 300)] : []),
    year: p.year ?? null, venue: p.venue?.slice(0, 500) ?? '', citations: p.citationCount ?? 0,
    references: [...new Set((p.references ?? []).flatMap(r => {
      const ref = semanticId(r.paperId); return ref && ref !== id ? [ref] : [];
    }))].slice(0, 2500),
    abstract: p.abstract?.slice(0, 30000) ?? '',
    doi: doi && doiPattern.test(doi) ? safeUrl(`https://doi.org/${doi.split('/').map(encodeURIComponent).join('/')}`) : null,
    url: safeUrl(p.url) ?? `https://www.semanticscholar.org/paper/${p.paperId.toLowerCase()}`,
    pdfUrl: safeUrl(p.openAccessPdf?.url), openAccess: p.isOpenAccess === true,
    topics: (p.fieldsOfStudy ?? []).slice(0, 12).map(t => t.slice(0, 300)),
  };
}

export class SemanticScholarProvider {
  private rateLimiter?: SemanticRateLimiter;
  private provenance = new WeakMap<object, { meta: DataMeta; expiresAt: number }>();

  constructor(private options: { cache: PersistentCache; apiKey?: string; offline?: boolean;
    fetch?: typeof fetch; timeoutMs?: number; databaseUrl?: string; rateLimiter?: SemanticRateLimiter }) {}

  metadata(data: object): DataMeta {
    return this.provenance.get(data)?.meta ?? { provider: 'semantic-scholar', source: 'live',
      fetchedAt: new Date().toISOString(), warning: S2_LICENSE_WARNING };
  }

  expiresAt(data: object): number { return this.provenance.get(data)?.expiresAt ?? Date.now() + 24 * 60 * 60 * 1000; }

  private record(data: object, meta: DataMeta, expiresAt: number) {
    const provenance = { meta, expiresAt };
    this.provenance.set(data, provenance);
    if (Array.isArray(data)) {
      for (const paper of data) if (paper) this.provenance.set(paper, provenance);
    } else if ('data' in data && Array.isArray(data.data)) {
      for (const row of data.data) {
        this.provenance.set(row, provenance);
        if (row.citedPaper) this.provenance.set(row.citedPaper, provenance);
        if (row.citingPaper) this.provenance.set(row.citingPaper, provenance);
      }
    }
  }

  private async request<T extends object>(path: string, params: Record<string, string>, schema: z.ZodType<T>,
    validate: (data: T) => boolean, signal?: AbortSignal, ids?: string[]): Promise<T> {
    signal?.throwIfAborted();
    // Defense in depth even though callers only use the fixed methods below.
    const route = path.match(/^\/graph\/v1\/paper\/([^/]+)(?:\/(references|citations))?$/);
    let lookup: string | null = null;
    try { lookup = route ? semanticLookup(decodeURIComponent(route[1])) : null; } catch { /* Invalid encoded segment. */ }
    const valid = ids ? path === '/graph/v1/paper/batch' && ids.length > 0 && ids.length <= 100 && ids.every(id => hex.test(id))
      : path === '/graph/v1/paper/search' || !!route && !!lookup && route[1] === encodeURIComponent(lookup) && (!route[2] || hex.test(lookup));
    if (!valid) throw new SemanticScholarError(400, 'Invalid Semantic Scholar route');
    const url = new URL(path, S2_ORIGIN);
    for (const [key, value] of Object.entries(params).sort(([a], [b]) => a.localeCompare(b))) url.searchParams.set(key, value);
    const body = ids ? JSON.stringify({ ids }) : undefined;
    const key = `s2:raw:v1:${ids ? 'POST' : 'GET'}:${url.pathname}${url.search}${body ? `:${createHash('sha256').update(body).digest('hex')}` : ''}`;
    const envelope = z.object({ data: schema, meta: MetaSchema }).refine(e => validate(e.data));
    const cached = await this.options.cache.get<unknown>(key, this.options.offline);
    signal?.throwIfAborted();
    const parsed = cached && envelope.safeParse(cached.value);
    if (cached && parsed?.success) {
      this.record(parsed.data.data, { ...parsed.data.meta, source: 'cache',
        ...(cached.expiresAt <= Date.now() ? { warning: `${parsed.data.meta.warning ?? ''} Offline: stale cached Semantic Scholar response.` } : {}) }, cached.expiresAt);
      return parsed.data.data;
    }
    if (this.options.offline) throw new SemanticScholarError(503, 'Offline: Semantic Scholar response is not cached');
    return this.options.cache.deduplicate(key, async sharedSignal => {
      const timeoutMs = Math.min(12000, this.options.timeoutMs ?? 12000);
      const deadlineAt = Date.now() + timeoutMs;
      const deadline = AbortSignal.any([sharedSignal, AbortSignal.timeout(timeoutMs)]);
      let reservation: SemanticRateReservation | undefined;
      let retryAfter: number | undefined;
      let terminalNotFound = false;
      try {
        const limiter = this.rateLimiter ??= this.options.rateLimiter ?? createSemanticRateLimiter(this.options);
        reservation = await limiter.reserve(deadline);
        reservation.assertValid();
        const response = await (this.options.fetch ?? fetch)(url, { method: ids ? 'POST' : 'GET', body,
          redirect: 'error', signal: deadline, headers: { Accept: 'application/json',
            ...(ids ? { 'Content-Type': 'application/json' } : {}),
            ...(this.options.apiKey ? { 'x-api-key': this.options.apiKey } : {}) } });
        if (!response.ok) {
          try {
            if (response.status === 429) {
              retryAfter = semanticRetryAfter(response.headers.get('retry-after'));
              // Persist before body cancellation can exhaust the provider's deadline.
              await reservation.cooldown?.(retryAfter, deadline);
            }
          } finally { await response.body?.cancel(); }
          throw new SemanticScholarError(response.status === 404 ? 404 : response.status === 429 ? 429 : 503,
            response.status === 429 ? 'Semantic Scholar rate limited; wait before trying again' : 'Semantic Scholar is unavailable', retryAfter);
        }
        if (!response.body || Number(response.headers.get('content-length')) > 12 * 1024 * 1024) {
          await response.body?.cancel(); throw new SemanticScholarError(502, 'Semantic Scholar response exceeds size limit');
        }
        const reader = response.body.getReader(), chunks: Uint8Array[] = [];
        let bytes = 0;
        const cancel = () => { void reader.cancel().catch(() => {}); };
        deadline.addEventListener('abort', cancel, { once: true });
        try {
          while (true) {
            deadline.throwIfAborted();
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 12 * 1024 * 1024) { await reader.cancel(); throw new SemanticScholarError(502, 'Semantic Scholar response exceeds size limit'); }
            chunks.push(value);
          }
        } finally { deadline.removeEventListener('abort', cancel); reader.releaseLock(); }
        deadline.throwIfAborted();
        const result = schema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (!result.success || !validate(result.data)) throw new SemanticScholarError(502, 'Invalid Semantic Scholar response');
        deadline.throwIfAborted();
        const ttl = (path.endsWith('/search') ? 6 : 24) * 60 * 60 * 1000;
        const meta: DataMeta = { provider: 'semantic-scholar', source: 'live', fetchedAt: new Date().toISOString(), warning: S2_LICENSE_WARNING };
        await this.options.cache.set(key, { data: result.data, meta }, ttl);
        const stored = await this.options.cache.get(key, true);
        this.record(result.data, meta, stored?.expiresAt ?? Date.now() + ttl);
        deadline.throwIfAborted();
        return result.data;
      } catch (error) {
        if (sharedSignal.aborted) throw sharedSignal.reason;
        if (error instanceof SemanticRateLimitError) throw new SemanticScholarError(error.status, error.message, error.retryAfter);
        if (error instanceof SemanticScholarError) { terminalNotFound = error.status === 404; throw error; }
        throw new SemanticScholarError(503);
      } finally {
        if (reservation) {
          try { await reservation.release(retryAfter, AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()))); }
          catch {
            if (sharedSignal.aborted) throw sharedSignal.reason;
            // Cleanup must not turn a genuine missing paper into stale-cache fallback.
            if (!terminalNotFound) throw new SemanticScholarError(503, 'Semantic Scholar shared rate gate is unavailable');
          }
        }
      }
    }, signal);
  }

  async getPaper(id: string, signal?: AbortSignal): Promise<SemanticPaper> {
    const lookup = semanticLookup(id);
    if (!lookup) throw new SemanticScholarError(400, 'Use a Semantic Scholar paper ID, DOI, or arXiv ID');
    const paper = await this.request(`/graph/v1/paper/${encodeURIComponent(lookup)}`, { fields: S2_FULL_FIELDS }, RawPaperSchema,
      p => !hex.test(lookup) || p.paperId.toLowerCase() === lookup.toLowerCase(), signal);
    const expiresAt = this.expiresAt(paper);
    if (!hex.test(lookup) && expiresAt > Date.now()) {
      signal?.throwIfAborted();
      const url = new URL(`/graph/v1/paper/${paper.paperId.toLowerCase()}`, S2_ORIGIN);
      url.searchParams.set('fields', S2_FULL_FIELDS);
      const canonicalKey = `s2:raw:v1:GET:${url.pathname}${url.search}`;
      const existing = await this.options.cache.get<unknown>(canonicalKey);
      signal?.throwIfAborted();
      const meta = this.metadata(paper);
      const parsed = existing && z.object({ data: RawPaperSchema, meta: MetaSchema }).safeParse(existing.value);
      if (!existing || !parsed?.success || Date.parse(parsed.data.meta.fetchedAt) <= Date.parse(meta.fetchedAt) && existing.expiresAt <= expiresAt) {
        await this.options.cache.set(canonicalKey, { data: paper, meta }, expiresAt - Date.now());
      }
    }
    return paper;
  }

  async search(q: string, page: number, signal?: AbortSignal): Promise<SemanticSearchPage> {
    if (!Number.isInteger(page) || page < 1 || page > 50) throw new SemanticScholarError(400, S2_SEARCH_WARNING);
    if (!q.trim() || q.length > 200 || /[\x00-\x1f\x7f]/.test(q)) throw new SemanticScholarError(400, 'Invalid Semantic Scholar search query');
    const offset = (page - 1) * 20;
    return this.request('/graph/v1/paper/search', { query: q, offset: String(offset), limit: '20', fields: S2_FULL_FIELDS },
      SearchSchema, p => p.offset === offset && (p.next === undefined || p.next > p.offset), signal);
  }

  async references(id: string, signal?: AbortSignal) {
    const canonical = semanticId(id);
    if (!canonical) throw new SemanticScholarError(400, 'Invalid Semantic Scholar ID');
    return this.request(`/graph/v1/paper/${canonical.slice(3)}/references`, { fields: S2_FIELDS, offset: '0', limit: '80' },
      ReferenceSchema, p => p.offset === 0 && p.data.length <= 80 && (p.next === undefined || p.next > 0), signal);
  }

  async citations(id: string, signal?: AbortSignal) {
    const canonical = semanticId(id);
    if (!canonical) throw new SemanticScholarError(400, 'Invalid Semantic Scholar ID');
    return this.request(`/graph/v1/paper/${canonical.slice(3)}/citations`, { fields: S2_FIELDS, offset: '0', limit: '100' },
      CitationSchema, p => p.offset === 0 && (p.next === undefined || p.next > 0), signal);
  }

  async batch(ids: string[], signal?: AbortSignal): Promise<SemanticPaper[]> {
    signal?.throwIfAborted();
    if (ids.some(id => !semanticId(id))) throw new SemanticScholarError(400, 'Invalid Semantic Scholar batch ID');
    const unique = [...new Set(ids.map(id => semanticId(id)!.slice(3)))].slice(0, 300);
    const records: SemanticPaper[] = [], metadata: DataMeta[] = [], expiries: number[] = [];
    for (let start = 0; start < unique.length; start += 100) {
      const chunk = unique.slice(start, start + 100);
      const page = await this.request('/graph/v1/paper/batch', { fields: S2_FULL_FIELDS }, BatchSchema,
        p => p.length === chunk.length && p.every((paper, index) => !paper || paper.paperId.toLowerCase() === chunk[index]), signal, chunk);
      records.push(...page.filter((p): p is SemanticPaper => p !== null));
      metadata.push(this.metadata(page)); expiries.push(this.expiresAt(page));
    }
    if (metadata.length) this.record(records, { provider: 'semantic-scholar',
      source: metadata.some(m => m.source === 'live') ? 'live' : 'cache',
      fetchedAt: metadata.map(m => m.fetchedAt).sort()[0], warning: [...new Set(metadata.flatMap(m => m.warning ? [m.warning] : []))].join(' ') }, Math.min(...expiries));
    return records;
  }
}
