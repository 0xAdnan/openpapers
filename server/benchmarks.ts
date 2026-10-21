import type { DataMeta, Paper } from '../shared/types.ts';
import { BenchmarkQuerySchema, BenchmarkResponseSchema, PaperBenchmarksResponseSchema, benchmarkEvidence, resolveBenchmark, type BenchmarkQuery, type BenchmarkResponse, type PaperBenchmarksResponse } from '../shared/benchmarks.ts';
import { normalizeWork, SELECT, type OpenAlexWork, type WorksPage } from './openalex.ts';
import { ApiError, type PaperService } from './service.ts';
import { staleAge } from './cache.ts';
import { createHash } from 'node:crypto';
import { BenchmarkSources } from './benchmark-sources.ts';

const TTL = 6 * 60 * 60 * 1000;
const publishedTypes = 'article|conference-paper|book-chapter|review|data-paper|software-paper';
const coverage = 'OpenAlex indexed text matches, not a verified list of benchmark users. A mention or citation does not prove evaluation on this benchmark. Full text is not available for every paper; indexing delays and name variants can omit papers. Dataset/software records are excluded from live results; separate preprint and published records may both appear. Results are ordered and filtered across the indexed matches before pagination. No scores or SOTA claims are inferred.';

export class BenchmarkService {
  private sources: BenchmarkSources;
  constructor(private service: PaperService, private options: { timeoutMs?: number; sources?: BenchmarkSources } = {}) {
    this.sources = options.sources ?? new BenchmarkSources(service.cache);
  }

  async inPaper(response: { paper: Paper; meta: DataMeta }, signal?: AbortSignal): Promise<PaperBenchmarksResponse> {
    signal?.throwIfAborted();
    const key = `paper-benchmarks:v6:${createHash('sha256').update(JSON.stringify(response.paper)).digest('hex')}`;
    const entry = await this.service.cache.get<unknown>(key);
    const cached = PaperBenchmarksResponseSchema.safeParse(entry?.value);
    signal?.throwIfAborted();
    if (cached.success && cached.data.paper.id === response.paper.id) return { ...cached.data, ...response,
      coverage: { ...cached.data.coverage, discovery: { ...cached.data.coverage.discovery,
        limitations: `${this.service.offline ? 'Offline mode. ' : ''}Cached discovery. ${cached.data.coverage.discovery.limitations}` } } };
    const result = await this.service.cache.deduplicate(key, async sharedSignal => {
      const deadline = AbortSignal.any([sharedSignal, AbortSignal.timeout(this.options.timeoutMs ?? 22000)]);
      const found = await this.sources.discover(response.paper, deadline, this.service.offline);
      const result = PaperBenchmarksResponseSchema.parse({ ...response, ...found });
      sharedSignal.throwIfAborted();
      const fetched = result.coverage.discovery.sources.flatMap(source => source.fetchedAt ? [Date.parse(source.fetchedAt)] : []);
      const ttl = result.coverage.discovery.status !== 'complete' ? 30000 : Math.max(0, Math.min(Date.now(), ...fetched) + TTL - Date.now());
      await this.service.cache.set(key, result, ttl);
      return result;
    }, signal);
    return { ...result, ...response };
  }

  async search(input: BenchmarkQuery, signal?: AbortSignal): Promise<BenchmarkResponse> {
    const parsed = BenchmarkQuerySchema.safeParse(input);
    if (!parsed.success) throw new ApiError(400, 'Invalid benchmark or filters. Use a benchmark name, page 1–100, and years 1900–2100 in ascending order.');
    const query = parsed.data;
    const benchmark = resolveBenchmark(query.q);
    if (!benchmark.name) throw new ApiError(400, 'Enter a benchmark name after your request.');
    signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60000)]);
    await this.service.ready;
    signal.throwIfAborted();
    const key = `benchmark:v2:${JSON.stringify({ ...query, q: benchmark.name.toLowerCase() })}`;
    const readCache = async (stale = false) => {
      const entry = await this.service.cache.get<unknown>(key, stale);
      const result = BenchmarkResponseSchema.safeParse(entry?.value);
      return result.success ? result.data : undefined;
    };
    const cached = await readCache();
    const cachedAge = cached && staleAge(cached.meta.fetchedAt);
    if (cached && cachedAge) return { ...cached, meta: { ...cached.meta, source: 'cache',
      ...(this.service.offline ? { warning: `Offline mode: cached benchmark matches are ${cachedAge}.` } : {}) } };
    if (!this.service.offline) {
      try {
        return await this.service.cache.deduplicate(key, async sharedSignal => {
          const params: Record<string, string> = {
            select: `${SELECT},publication_date,type`, per_page: '20', page: String(query.page),
            sort: query.sort === 'citations' ? 'cited_by_count:desc,publication_date:desc' : `publication_date:${query.sort === 'oldest' ? 'asc' : 'desc'},cited_by_count:desc`,
          };
          const scope = query.evidence === 'title' ? 'search.title' : query.evidence === 'abstract' ? 'search.title_and_abstract' : 'search';
          params[scope] = `(${benchmark.aliases.map(alias => `"${alias}"`).join(' OR ')})`;
          // Each user term is a literal quoted phrase, never upstream Boolean/filter syntax.
          if (query.keyword) params.search = `${params.search ?? ''} ${params.search ? 'AND ' : ''}"${query.keyword}"`.trim();
          const filters = [
            query.publication === 'conference' ? 'type:conference-paper' :
              query.publication === 'any' ? `type:${publishedTypes}|preprint|dissertation|report` : `type:${publishedTypes}`,
            query.publication === 'published' ? 'primary_location.is_published:true' : null,
            query.publication === 'journal' ? 'primary_location.source.type:journal' : null,
            query.from === undefined ? null : `from_publication_date:${query.from}-01-01`,
            query.to === undefined ? null : `to_publication_date:${query.to}-12-31`,
            query.oa ? 'open_access.is_oa:true' : null,
            query.pdf ? 'has_pdf_url:true' : null,
          ].filter((filter): filter is string => !!filter);
          if (filters.length) params.filter = filters.join(',');
          const remote = await this.service.provider.request<WorksPage>('/works', params, sharedSignal, TTL);
          sharedSignal.throwIfAborted();
          const response = BenchmarkResponseSchema.parse({ benchmark, results: remote.results.map(work => this.result(normalizeWork(work), benchmark.aliases, work)),
            total: remote.meta.count, page: query.page, perPage: 20, meta: { ...this.service.provider.metadata(remote), provider: 'openalex', coverage } });
          await this.service.cache.set(key, response, Math.max(0, Date.parse(response.meta.fetchedAt) + TTL - Date.now()));
          return response;
        }, signal);
      } catch {
        signal.throwIfAborted();
      }
    }
    const stale = await readCache(true);
    const age = stale && staleAge(stale.meta.fetchedAt);
    if (stale && age) return { ...stale, meta: { ...stale.meta, source: 'cache', warning: `${this.service.offline ? 'Offline mode' : 'OpenAlex unavailable'}: cached benchmark matches are ${age}.` } };
    const local = await this.service.localMetadata();
    // Keep publication evidence from benchmark caches; legacy Paper records do not carry it.
    const publications = new Map<string, { result: BenchmarkResponse['results'][number]; fetchedAt: string }>();
    for (const entry of await this.service.cache.list<unknown>('benchmark:')) {
      const parsed = BenchmarkResponseSchema.safeParse(entry.value);
      if (!parsed.success || !staleAge(parsed.data.meta.fetchedAt)) continue;
      for (const result of parsed.data.results) {
        const previous = publications.get(result.paper.id);
        if (!previous || Date.parse(previous.fetchedAt) < Date.parse(parsed.data.meta.fetchedAt)) {
          publications.set(result.paper.id, { result, fetchedAt: parsed.data.meta.fetchedAt });
        }
      }
    }
    signal.throwIfAborted();
    const matches = local.map(item => {
      const cached = publications.get(item.paper.id);
      const result = cached && Date.parse(cached.fetchedAt) >= Date.parse(item.meta.fetchedAt) ?
        { ...cached.result, paper: item.paper, evidence: benchmarkEvidence(item.paper, benchmark.aliases) } : this.result(item.paper, benchmark.aliases);
      return { ...item, result };
    }).filter(({ paper, result }) => {
      const evidence = result.evidence;
      return evidence.kind !== 'indexed' && (query.evidence !== 'title' || evidence.kind === 'title') &&
        (query.publication === 'any' || (query.publication === 'published' ? result.publication.published === true : result.publication.kind === query.publication)) &&
        (query.from === undefined || paper.year !== null && paper.year >= query.from) &&
        (query.to === undefined || paper.year !== null && paper.year <= query.to) &&
        (!query.oa || paper.openAccess) && (!query.pdf || paper.pdfUrl !== null) &&
        (!query.keyword || `${paper.title} ${paper.abstract}`.toLowerCase().includes(query.keyword.toLowerCase()));
    }).sort((a, b) => {
      if (query.sort === 'citations' && a.paper.citations !== b.paper.citations) return b.paper.citations - a.paper.citations;
      if (a.paper.year === null && b.paper.year !== null) return 1;
      if (b.paper.year === null && a.paper.year !== null) return -1;
      return (query.sort === 'oldest' ? 1 : -1) * ((a.paper.year ?? 0) - (b.paper.year ?? 0)) || b.paper.citations - a.paper.citations || a.paper.id.localeCompare(b.paper.id);
    });
    const selected = matches.slice((query.page - 1) * 20, query.page * 20);
    return { benchmark, results: selected.map(({ result }) => result), total: matches.length, page: query.page, perPage: 20,
      meta: { source: matches.some(item => item.meta.source === 'cache') ? 'cache' : 'snapshot', provider: 'openalex',
        fetchedAt: matches.map(item => item.meta.fetchedAt).sort()[0] ?? local.map(item => item.meta.fetchedAt).sort()[0] ?? new Date().toISOString(), coverage,
        warning: `${this.service.offline ? 'Offline mode' : 'OpenAlex is unavailable'}: searching bundled and previously cached titles/abstracts only. Counts cover the local collection, not the full corpus; local sorting uses publication years.${query.publication !== 'any' ? ' Publication filters omit local papers without publication metadata.' : ''}` } };
  }

  private result(paper: Paper, aliases: string[], work?: OpenAlexWork): BenchmarkResponse['results'][number] {
    const type = work?.type;
    const source = work?.primary_location?.source?.type;
    const publication: BenchmarkResponse['results'][number]['publication'] = {
      kind: type === 'preprint' ? 'preprint' : type === 'conference-paper' ? 'conference' :
        source === 'journal' ? 'journal' : type ? 'other' : 'unknown',
      published: type === 'preprint' ? false : type && publishedTypes.split('|').includes(type) ? work?.primary_location?.is_published ?? null : null,
    };
    return { paper, publicationDate: /^\d{4}-\d{2}-\d{2}$/.test(work?.publication_date ?? '') ? work!.publication_date! : null,
      publication,
      evidence: benchmarkEvidence(paper, aliases) };
  }
}
