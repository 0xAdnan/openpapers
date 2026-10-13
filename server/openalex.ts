import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { DataMeta, Paper } from '../shared/types.ts';
import { PersistentCache } from './cache.ts';

export const OPENALEX_ORIGIN = 'https://api.openalex.org';
export const ID_PATTERN = /^W[1-9]\d{0,14}$/;
export const SELECT = 'id,doi,display_name,publication_year,authorships,primary_location,best_oa_location,open_access,cited_by_count,referenced_works,related_works,abstract_inverted_index,topics';

export interface OpenAlexWork {
  id: string;
  display_name?: string | null;
  doi?: string | null;
  publication_year?: number | null;
  authorships?: { author?: { display_name?: string } }[];
  primary_location?: Location | null;
  best_oa_location?: Location | null;
  open_access?: { is_oa?: boolean; oa_url?: string | null };
  cited_by_count?: number;
  referenced_works?: string[];
  related_works?: string[];
  abstract_inverted_index?: Record<string, number[]> | null;
  topics?: { display_name?: string }[];
}

interface Location {
  source?: { display_name?: string } | null;
  landing_page_url?: string | null;
  pdf_url?: string | null;
}

export interface WorksPage {
  results: OpenAlexWork[];
  meta: { count: number; next_cursor?: string | null };
}

export interface Acquisition {
  path: string;
  params: Record<string, string>;
  fetchedAt: string;
  responseSha256: string;
  resultCount: number;
  total: number;
  creditsUsed: string | null;
  fromCache?: boolean;
  hashKind?: 'original-response' | 'reserialized-json';
}

export class ProviderError extends Error {
  constructor(public status: number, message = 'OpenAlex is unavailable', public retryAfter?: number) {
    super(message);
  }
}

export function workId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.replace(/^https:\/\/openalex\.org\//, '');
  return ID_PATTERN.test(id) ? id : null;
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function normalizeWork(work: OpenAlexWork): Paper {
  const id = workId(work.id);
  if (!id) throw new ProviderError(502, 'Invalid OpenAlex response');
  const words: string[] = [];
  for (const [word, positions] of Object.entries(work.abstract_inverted_index ?? {}).slice(0, 8000)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions.slice(0, 1000)) {
      if (Number.isInteger(position) && position >= 0 && position < 8000) words[position] = word.slice(0, 200);
    }
  }
  const references = [...new Set((work.referenced_works ?? []).map(workId).filter((x): x is string => !!x && x !== id))].slice(0, 2500);
  return {
    id,
    title: work.display_name?.slice(0, 2000) || 'Untitled work',
    authors: (work.authorships ?? []).slice(0, 100).flatMap(a => a.author?.display_name ? [a.author.display_name.slice(0, 300)] : []),
    year: Number.isInteger(work.publication_year) ? work.publication_year! : null,
    venue: work.primary_location?.source?.display_name?.slice(0, 500) ?? '',
    citations: Math.max(0, Number.isFinite(work.cited_by_count) ? work.cited_by_count! : 0),
    references,
    abstract: words.filter(Boolean).join(' ').slice(0, 30000),
    doi: safeUrl(work.doi),
    url: safeUrl(work.primary_location?.landing_page_url) ?? safeUrl(work.doi) ?? `https://openalex.org/${id}`,
    pdfUrl: safeUrl(work.best_oa_location?.pdf_url) ?? safeUrl(work.primary_location?.pdf_url),
    openAccess: work.open_access?.is_oa === true,
    topics: (work.topics ?? []).slice(0, 12).flatMap(t => t.display_name ? [t.display_name.slice(0, 300)] : []),
  };
}

export class OpenAlexProvider {
  private active = 0;
  private waiting: (() => void)[] = [];
  private calls = 0;
  private day = new Date().toISOString().slice(0, 10);
  private nextStart = 0;
  private cooldownUntil = 0;
  private cooldownStatus: 429 | 503 = 503;
  readonly acquisitions: Acquisition[] = [];
  private provenance = new WeakMap<object, DataMeta>();

  constructor(private options: {
    cache: PersistentCache;
    apiKey?: string;
    offline?: boolean;
    fetch?: typeof fetch;
    timeoutMs?: number;
    maxRequests?: number;
  }) {}

  metadata(data: object): DataMeta {
    return this.provenance.get(data) ?? { source: 'live', fetchedAt: new Date().toISOString() };
  }

  private record(data: WorksPage | OpenAlexWork, acquisition: Acquisition, source: 'live' | 'cache') {
    this.acquisitions.push(acquisition);
    if (this.acquisitions.length > 250) this.acquisitions.shift();
    const meta: DataMeta = { source, fetchedAt: acquisition.fetchedAt };
    this.provenance.set(data, meta);
    if ('results' in data) for (const work of data.results) this.provenance.set(work, meta);
  }

  private async slot(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.active >= 2) {
      if (this.waiting.length >= 16) throw new ProviderError(503, 'OpenAlex request queue is full');
      await new Promise<void>((resolve, reject) => {
        const grant = () => { signal.removeEventListener('abort', cancel); resolve(); };
        const cancel = () => {
          this.waiting.splice(this.waiting.indexOf(grant), 1);
          reject(signal.reason);
        };
        this.waiting.push(grant);
        signal.addEventListener('abort', cancel, { once: true });
      });
    } else {
      this.active++;
    }
    try {
      const wait = Math.max(0, this.nextStart - Date.now());
      this.nextStart = Math.max(Date.now(), this.nextStart) + 250;
      if (wait) await delay(wait, undefined, { signal });
      signal.throwIfAborted();
    } catch (error) {
      this.release();
      throw error;
    }
  }

  private release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  async request<T extends WorksPage | OpenAlexWork>(path: string, params: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    // No redirects and no caller-supplied origins: only these fixed provider routes.
    if (path !== '/works' && !/^\/works\/W[1-9]\d{0,14}$/.test(path)) throw new ProviderError(400, 'Invalid provider path');
    const url = new URL(path, OPENALEX_ORIGIN);
    for (const [key, value] of Object.entries(params).sort(([a], [b]) => a.localeCompare(b))) url.searchParams.set(key, value);
    const key = `oa:${url.pathname}${url.search}`;
    const valid = (data: unknown): data is T => {
      if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
      if (path !== '/works') return workId((data as OpenAlexWork).id) === path.slice('/works/'.length);
      const page = data as WorksPage;
      const cursor = page.meta?.next_cursor;
      return Array.isArray(page.results) && page.results.length <= 100 &&
        !!page.meta && typeof page.meta === 'object' && !Array.isArray(page.meta) &&
        Number.isInteger(page.meta.count) && page.meta.count >= 0 &&
        (!Object.hasOwn(page.meta, 'next_cursor') || cursor === null ||
          typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 2000) &&
        page.results.every(work => !!workId(work?.id));
    };
    const cached = await this.options.cache.get<T>(key, this.options.offline);
    if (cached && valid(cached.value)) {
      const original = await this.options.cache.get<Acquisition>(`provenance:${key}`, true);
      const acquisition = original && typeof original.value?.fetchedAt === 'string' && Number.isFinite(Date.parse(original.value.fetchedAt))
        ? original.value : undefined;
      this.record(cached.value, { ...(acquisition ?? {
        path, params, fetchedAt: cached.storedAt,
        responseSha256: createHash('sha256').update(JSON.stringify(cached.value)).digest('hex'),
        hashKind: 'reserialized-json',
        resultCount: path === '/works' ? (cached.value as WorksPage).results.length : 1,
        total: path === '/works' ? (cached.value as WorksPage).meta.count : 1,
        creditsUsed: null,
      }), fromCache: true }, 'cache');
      return cached.value;
    }
    if (this.options.offline) throw new ProviderError(503, 'Offline mode');
    return this.options.cache.deduplicate(key, async sharedSignal => {
      const deadline = AbortSignal.any([sharedSignal, AbortSignal.timeout(this.options.timeoutMs ?? 12000)]);
      let acquired = false;
      try {
        await this.slot(deadline);
        acquired = true;
        const today = new Date().toISOString().slice(0, 10);
        if (today !== this.day) { this.day = today; this.calls = 0; }
        // A conservative process-local circuit breaker, not a billing guarantee.
        if (Date.now() < this.cooldownUntil) {
          throw new ProviderError(this.cooldownStatus, 'OpenAlex cooldown reached', Math.ceil((this.cooldownUntil - Date.now()) / 1000));
        }
        if (this.calls >= (this.options.maxRequests ?? (this.options.apiKey ? 250 : 50))) {
          const tomorrow = Date.parse(`${today}T00:00:00.000Z`) + 24 * 60 * 60 * 1000;
          throw new ProviderError(503, 'OpenAlex request budget reached', Math.max(1, Math.ceil((tomorrow - Date.now()) / 1000)));
        }
        this.calls++;
        const response = await (this.options.fetch ?? fetch)(url, {
          redirect: 'error',
          signal: deadline,
          headers: {
            Accept: 'application/json',
            'User-Agent': 'OpenPapers/0.1 (open-source research graph; OpenAlex)',
            ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
          },
        });
        if (!response.ok) {
          const now = Date.now();
          let retryAfter: number | undefined;
          if (response.status === 429) {
            const header = response.headers.get('retry-after')?.trim();
            const seconds = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header)
              : header ? (Date.parse(header) - now) / 1000 : NaN;
            retryAfter = Math.ceil(Math.min(24 * 60 * 60, Math.max(60, Number.isFinite(seconds) ? seconds : 3600)));
            this.cooldownUntil = Math.max(this.cooldownUntil, now + retryAfter * 1000);
            this.cooldownStatus = 429;
          }
          if (response.status >= 500 && this.cooldownUntil <= now + 30000) {
            this.cooldownUntil = now + 30000;
            this.cooldownStatus = 503;
          }
          await response.body?.cancel().catch(() => {});
          throw new ProviderError([400, 401, 403, 404, 429].includes(response.status) ? response.status : 503,
            response.status === 429 ? 'OpenAlex rate limited; wait before trying again' : 'OpenAlex is unavailable', retryAfter);
        }
        if (!response.body) throw new ProviderError(502);
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 12 * 1024 * 1024) { await reader.cancel(); throw new ProviderError(502); }
          chunks.push(value);
        }
        const text = Buffer.concat(chunks).toString('utf8');
        deadline.throwIfAborted();
        const data: unknown = JSON.parse(text);
        if (!valid(data)) {
          throw new ProviderError(502, 'Invalid OpenAlex response');
        }
        const acquisition: Acquisition = {
          path, params, fetchedAt: new Date().toISOString(),
          responseSha256: createHash('sha256').update(text).digest('hex'),
          hashKind: 'original-response',
          resultCount: path === '/works' ? (data as WorksPage).results.length : 1,
          total: path === '/works' ? (data as WorksPage).meta.count : 1,
          creditsUsed: response.headers.get('x-ratelimit-credits-used'),
        };
        this.record(data, acquisition, 'live');
        await this.options.cache.set(key, data);
        await this.options.cache.set(`provenance:${key}`, acquisition);
        return data;
      } catch (error) {
        if (sharedSignal.aborted) throw sharedSignal.reason;
        if (error instanceof ProviderError) throw error;
        if (this.cooldownUntil <= Date.now() + 30000) {
          this.cooldownUntil = Date.now() + 30000;
          this.cooldownStatus = 503;
        }
        throw new ProviderError(503);
      } finally {
        if (acquired) this.release();
      }
    }, signal);
  }

  async getPaper(id: string, signal?: AbortSignal) {
    if (!ID_PATTERN.test(id)) throw new ProviderError(400, 'Invalid OpenAlex ID');
    return this.request<OpenAlexWork>(`/works/${id}`, { select: SELECT }, signal);
  }

  async batch(ids: string[], signal?: AbortSignal) {
    signal?.throwIfAborted();
    const unique = [...new Set(ids)].filter(id => ID_PATTERN.test(id)).slice(0, 300);
    const records: OpenAlexWork[] = [];
    for (let start = 0; start < unique.length; start += 100) {
      const page = await this.request<WorksPage>('/works', {
        filter: `openalex_id:${unique.slice(start, start + 100).join('|')}`,
        per_page: '100', select: SELECT,
      }, signal);
      records.push(...page.results);
      const previous = this.provenance.get(records);
      const current = this.metadata(page);
      this.provenance.set(records, { source: previous?.source === 'live' || current.source === 'live' ? 'live' : 'cache',
        fetchedAt: [previous?.fetchedAt, current.fetchedAt].filter((date): date is string => !!date).sort()[0] });
    }
    return records;
  }

  async search(q: string, page: number, signal?: AbortSignal) {
    const query = q.trim();
    const doi = query.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
    // arXiv links and IDs resolve through their registered DataCite DOI; versions are dropped.
    const arxiv = /^(?:arxiv:\s*|(?:https?:\/\/)?(?:www\.)?arxiv\.org\/(?:abs|pdf)\/)(\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?\/?$/i.exec(query);
    const pmid = /^(?:pmid:?\s*|(?:https?:\/\/)?pubmed\.ncbi\.nlm\.nih\.gov\/)(\d{1,9})\/?$/i.exec(query);
    const params: Record<string, string> = { per_page: '20', page: String(page), select: SELECT };
    if (arxiv) params.filter = `doi:https://doi.org/10.48550/arxiv.${arxiv[1]}`;
    else if (pmid) params.filter = `ids.pmid:${pmid[1]}`;
    else if (/^10\.\d{4,9}\/[^\s,|]+$/i.test(doi)) params.filter = `doi:https://doi.org/${doi}`;
    else params.search = q;
    return this.request<WorksPage>('/works', params, signal);
  }
}
