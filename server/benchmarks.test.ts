import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BenchmarkQuerySchema, BenchmarkResponseSchema, PaperBenchmarksResponseSchema, benchmarkEvidence, resolveBenchmark, type BenchmarkQuery } from '../shared/benchmarks.ts';
import { discoverBenchmarks } from '../shared/benchmark-discovery.ts';
import { BenchmarkSources } from './benchmark-sources.ts';
import { PersistentCache } from './cache.ts';
import { OpenAlexProvider, normalizeWork, type OpenAlexWork, type WorksPage } from './openalex.ts';
import { PaperService } from './service.ts';
import { BenchmarkService } from './benchmarks.ts';
import { createApp } from './index.ts';
import { SemanticService } from './semantic-service.ts';

const inverted = (text: string) => {
  const index: Record<string, number[]> = {};
  text.split(' ').forEach((word, position) => (index[word] ??= []).push(position));
  return index;
};
const work = (id: number, title: string, year: number | null, abstract = '', citations = 0): OpenAlexWork => ({
  id: `https://openalex.org/W${id}`, display_name: title, publication_year: year,
  publication_date: year ? `${year}-06-01` : null, abstract_inverted_index: inverted(abstract), cited_by_count: citations,
  open_access: { is_oa: id % 2 === 0 }, primary_location: { pdf_url: id % 2 === 0 ? `https://example.org/${id}.pdf` : null },
});
const records = [
  work(1, 'UI fixture: Defects4J experiments', 2026, '', 5),
  work(2, 'UI fixture: Repair evaluation', 2025, 'We evaluate program repair on Defects4J with reproducible experiments.', 20),
  work(3, 'UI fixture: A discussion of repair', 2024, 'This abstract does not mention a benchmark.', 100),
];
const query = (input: Partial<BenchmarkQuery> = {}) => BenchmarkQuerySchema.parse({ q: 'Defects4J', ...input });

async function setup(t: TestContext, fetcher?: typeof fetch) {
  const directory = await mkdtemp(join('/tmp/opencode', 'benchmark-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = new PersistentCache(directory);
  const provider = new OpenAlexProvider({ cache, fetch: fetcher ?? (async () => Response.json({ results: records, meta: { count: 45 } })) });
  const service = new PaperService(cache, false, provider);
  await service.ready;
  const sources = new BenchmarkSources(cache, { download: async () => { throw new Error('No remote sources in forward-search fixtures'); } });
  return { cache, provider, service, benchmarks: new BenchmarkService(service, { sources }), directory };
}

test('benchmark aliases and a small natural-language grammar resolve without an LLM', () => {
  for (const value of ['defects 4j', 'DEFECTS-4J', 'the benchmark is defects 4j', 'list me all papers that use Defects4J']) {
    assert.ok(resolveBenchmark(value).aliases.some(alias => alias.toLowerCase().replace(/[\s-]/g, '') === 'defects4j'));
  }
  assert.deepEqual(resolveBenchmark('Custom Dataset'), { name: 'Custom Dataset', aliases: ['Custom Dataset', 'CustomDataset'], url: null });
  assert.equal(resolveBenchmark('SWE bench').name, 'SWE bench');
});

test('validation rejects Boolean injection, filter syntax, duplicate scalar values, reversed years and oversized queries', () => {
  for (const input of [{ q: 'Defects4J" OR "anything' }, { q: 'name,filter:evil' }, { q: '<script>' },
    { q: 'a'.repeat(161) }, { page: ['2', '3'] }, { page: ['2'] }, { from: ['2020'] },
    { from: 2026, to: 2020 }, { page: 0 }, { page: 101 }, { oa: 'true' }, { publication: 'arxiv' }, { publication: ['published', 'any'] }, { unknown: 'x' }]) {
    assert.equal(BenchmarkQuerySchema.safeParse({ q: 'Defects4J', ...input }).success, false, JSON.stringify(input));
  }
  assert.equal(query().sort, 'newest');
  assert.equal(query().publication, 'any');
});

test('evidence uses bounded visible excerpts and does not claim benchmark usage', () => {
  assert.deepEqual(benchmarkEvidence({ title: 'Defects4J study', abstract: '' }, ['Defects4J']), { kind: 'title', excerpt: 'Defects4J study' });
  const evidence = benchmarkEvidence({ title: 'Repair', abstract: `${'before '.repeat(80)}We evaluate on defects 4j. ${'after '.repeat(80)}` }, ['Defects4J', 'Defects 4J']);
  assert.equal(evidence.kind, 'abstract');
  assert.ok(evidence.excerpt.includes('defects 4j'));
  assert.ok(evidence.excerpt.length <= 500);
  assert.equal(benchmarkEvidence({ title: 'NotDefects4Jish', abstract: '' }, ['Defects4J']).kind, 'indexed');
  assert.equal(benchmarkEvidence({ title: 'Discussion', abstract: '' }, ['Defects4J']).kind, 'indexed');
});

test('live benchmark search passes global sorting, literal aliases, filters and pagination to OpenAlex', async t => {
  let url!: URL;
  let headers!: Headers;
  const { benchmarks } = await setup(t, async (input, options) => {
    url = new URL(String(input)); headers = new Headers(options?.headers);
    return Response.json({ results: records, meta: { count: 45 } });
  });
  const response = await benchmarks.search(query({ q: 'the benchmark is defects 4j', page: 2, from: 2020, to: 2026, oa: '1', pdf: '1', keyword: 'program repair' }));
  assert.equal(url.origin, 'https://api.openalex.org');
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(url.searchParams.get('per_page'), '20');
  assert.equal(url.searchParams.get('sort'), 'publication_date:desc,cited_by_count:desc');
  assert.equal(url.searchParams.get('search'), '("defects 4j" OR "defects4j") AND "program repair"');
  assert.equal(url.searchParams.get('filter'), 'type:article|conference-paper|book-chapter|review|data-paper|software-paper|preprint|dissertation|report,from_publication_date:2020-01-01,to_publication_date:2026-12-31,open_access.is_oa:true,has_pdf_url:true');
  assert.equal(headers.get('accept'), 'application/json');
  assert.equal(response.total, 45);
  assert.equal(response.page, 2);
  assert.deepEqual(response.results.map(result => result.evidence.kind), ['title', 'abstract', 'indexed']);
  assert.equal(response.results[0].publicationDate, '2026-06-01');
  assert.match(response.meta.coverage, /not a verified list/);
  assert.equal(BenchmarkResponseSchema.safeParse(response).success, true);
});

test('scoped search, oldest and most-cited ordering have distinct cached requests', async t => {
  const urls: URL[] = [];
  const { benchmarks } = await setup(t, async input => {
    urls.push(new URL(String(input)));
    return Response.json({ results: records, meta: { count: 3 } });
  });
  await benchmarks.search(query({ evidence: 'title', sort: 'oldest' }));
  await benchmarks.search(query({ evidence: 'abstract', sort: 'citations', keyword: 'repair' }));
  const cached = await benchmarks.search(query({ evidence: 'title', sort: 'oldest' }));
  assert.equal(urls.length, 2);
  assert.equal(urls[0].searchParams.get('sort'), 'publication_date:asc,cited_by_count:desc');
  assert.ok(urls[0].searchParams.has('search.title'));
  assert.equal(urls[1].searchParams.get('sort'), 'cited_by_count:desc,publication_date:desc');
  assert.ok(urls[1].searchParams.has('search.title_and_abstract'));
  assert.equal(urls[1].searchParams.get('search'), '"repair"');
  assert.equal(cached.meta.source, 'cache');
});

test('benchmark raw search caches expire in six hours and do not renew original freshness', async t => {
  let calls = 0;
  const { cache, benchmarks, provider } = await setup(t, async () => {
    calls++; return Response.json({ results: records, meta: { count: 3 } });
  });
  const input = query();
  const first = await benchmarks.search(input);
  const [raw] = await cache.list<unknown>('oa:/works?');
  // Envelope timestamps use separate Date.now calls and may cross a millisecond tick.
  assert.ok(raw.expiresAt - Date.parse(raw.storedAt) <= 6 * 3600000 + 25);
  const key = `benchmark:v2:${JSON.stringify({ ...input, q: 'defects4j' })}`;
  await cache.set(key, first, -1);
  const reused = await benchmarks.search(input);
  const normalized = await cache.get(key);
  assert.ok(normalized);
  assert.equal(reused.meta.fetchedAt, first.meta.fetchedAt);
  // Computing the relative TTL and storing it can cross a clock tick.
  assert.ok(normalized.expiresAt <= Date.parse(first.meta.fetchedAt) + 6 * 3600000 + 25);
  assert.equal(calls, 1);
  // Simulate an older raw response with a future envelope expiry.
  await cache.set(raw.key, raw.value, 24 * 3600000);
  const entry = await cache.get(raw.key); assert.ok(entry);
  entry.storedAt = new Date(Date.now() - 7 * 3600000).toISOString();
  const params = Object.fromEntries(new URL(raw.key.slice(3), 'https://api.openalex.org').searchParams);
  await provider.request('/works', params, undefined, 6 * 3600000);
  assert.equal(calls, 2);
});

test('benchmark cache rejects mixed providers and duplicates; fresh offline entries keep warnings', async t => {
  const { cache, benchmarks, directory } = await setup(t);
  const first = await benchmarks.search(query());
  const key = `benchmark:v2:${JSON.stringify({ ...query(), q: 'defects4j' })}`;
  assert.equal(BenchmarkResponseSchema.safeParse({ ...first, results: [first.results[0], first.results[0]] }).success, false);
  await cache.set(key, { ...first, results: [{ ...first.results[0], paper: { ...first.results[0].paper, id: `S2:${'0'.repeat(40)}` } }] });
  let offline = new BenchmarkService(new PaperService(new PersistentCache(directory), true));
  const response = await offline.search(query());
  assert.equal(response.results.some(result => result.paper.id.startsWith('S2:')), false);
  await cache.set(key, first);
  offline = new BenchmarkService(new PaperService(new PersistentCache(directory), true));
  assert.match((await offline.search(query())).meta.warning!, /Offline mode/);
});

test('cancelled benchmark search stops transport and does not write results', async t => {
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let aborted = false;
  const { benchmarks, cache } = await setup(t, async (_input, options) => {
    started();
    await new Promise<void>((_resolve, reject) => options!.signal!.addEventListener('abort', () => {
      aborted = true; reject(options!.signal!.reason);
    }, { once: true }));
    return Response.json({ results: records, meta: { count: 3 } });
  });
  const controller = new AbortController();
  const pending = benchmarks.search(query(), controller.signal);
  const rejected = assert.rejects(pending, /cancelled/);
  await entered;
  controller.abort(new Error('cancelled'));
  await rejected;
  assert.equal(aborted, true);
  assert.equal((await cache.list('benchmark:')).length, 0);
});

test('offline local search composes filters, sorts globally, and never invents results', async t => {
  const { cache, directory } = await setup(t);
  const papers = records.map(record => ({ ...record, abstract_inverted_index: inverted('We evaluate program repair using Defects4J.') }));
  const { normalizeWork } = await import('./openalex.ts');
  const local = [...papers.map(normalizeWork), normalizeWork(work(4, 'UI fixture: Unknown year Defects4J', null, '', 30))];
  await cache.set('search:1:defects4j', { results: local, total: local.length, page: 1, perPage: 20,
    meta: { source: 'live', fetchedAt: new Date().toISOString() } });
  let calls = 0;
  const offline = new PaperService(new PersistentCache(directory), true, new OpenAlexProvider({ cache, offline: true, fetch: async () => { calls++; throw new Error('must not fetch'); } }));
  const benchmarks = new BenchmarkService(offline);
  const oldest = await benchmarks.search(query({ sort: 'oldest' }));
  assert.deepEqual(oldest.results.map(result => result.paper.id), ['W3', 'W2', 'W1', 'W4']);
  assert.match(oldest.meta.warning!, /local collection/);
  const filtered = await benchmarks.search(query({ from: 2025, to: 2025, oa: '1', pdf: '1', keyword: 'program repair', evidence: 'abstract' }));
  assert.deepEqual(filtered.results.map(result => result.paper.id), ['W2']);
  const title = await benchmarks.search(query({ evidence: 'title' }));
  assert.deepEqual(title.results.map(result => result.paper.id), ['W1', 'W4']);
  const empty = await benchmarks.search(query({ q: 'NeverSeenBenchmark' }));
  assert.equal(empty.total, 0);
  assert.equal(calls, 0);
});

test('recent stale benchmark cache is labelled; data older than 30 days is not returned', async t => {
  const { cache, directory, benchmarks } = await setup(t);
  const response = await benchmarks.search(query());
  const key = `benchmark:v2:${JSON.stringify({ ...query(), q: 'defects4j' })}`;
  await cache.set(key, { ...response, meta: { ...response.meta, fetchedAt: new Date(Date.now() - 2 * 3600000).toISOString() } }, -1);
  let offline = new BenchmarkService(new PaperService(new PersistentCache(directory), true));
  assert.match((await offline.search(query())).meta.warning!, /2 hours old/);
  await cache.set(key, { ...response, meta: { ...response.meta, fetchedAt: '2001-01-01T00:00:00Z' } }, -1);
  offline = new BenchmarkService(new PaperService(new PersistentCache(directory), true));
  const missing = await offline.search(query());
  assert.equal(missing.total, 0);
  assert.match(missing.meta.warning!, /Offline mode/);
});

test('API validates benchmark query values and returns schema-valid offline results', async t => {
  const { service } = await setup(t);
  const offline = new PaperService(service.cache, true);
  const semanticService = new SemanticService(service.cache, true);
  await Promise.all([offline.ready, semanticService.ready]);
  const server = createApp({ service: offline, semanticService, rateLimit: 1000 }).app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/benchmarks/papers`;
  for (const suffix of ['', '?q=Defects4J&page=2&page=3', '?q=Defects4J&page=2&page=2', '?q=Defects4J&from=2026&to=2020', '?q=Defects4J&sort=evil', '?q=Defects4J&oa=true', '?q=Defects4J&keyword=%22OR%22', '?q=Defects4J&publication=arxiv', '?q=Defects4J&publication=published&publication=any']) {
    assert.equal((await fetch(base + suffix)).status, 400, suffix);
  }
  const response = await fetch(`${base}?q=defects%204j`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(BenchmarkResponseSchema.safeParse(body).success, true);
  assert.equal(body.benchmark.name, 'defects 4j');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  for (const publication of ['any', 'published', 'conference', 'journal']) {
    const response = await fetch(`${base}?q=Defects4J&publication=${publication}&sort=newest&evidence=any`);
    assert.equal(response.status, 200, publication);
    assert.equal(BenchmarkResponseSchema.safeParse(await response.json()).success, true);
  }
});

test('publication filters are applied before pagination and do not filter by PDF host', async t => {
  const urls: URL[] = [];
  const conference: OpenAlexWork = { ...records[0], type: 'conference-paper', primary_location: {
    source: null, raw_source_name: 'Synthetic workshop proceedings', is_published: true,
    pdf_url: 'https://arxiv.org/pdf/2601.00001',
  } };
  const journal: OpenAlexWork = { ...records[1], type: 'article', primary_location: { source: { display_name: 'Synthetic journal', type: 'journal' }, is_published: true } };
  const preprint: OpenAlexWork = { ...records[2], type: 'preprint', primary_location: { source: { type: 'repository' }, is_published: false } };
  const { benchmarks } = await setup(t, async input => {
    const url = new URL(String(input)); urls.push(url);
    const filter = url.searchParams.get('filter')!;
    return Response.json({ results: filter === 'type:conference-paper' ? [conference] : filter.includes('source.type:journal') ? [journal] :
      filter.includes('is_published:true') ? [conference, journal] : [conference, journal, preprint], meta: { count: 77 } });
  });
  const all = await benchmarks.search(query());
  const conferences = await benchmarks.search(query({ publication: 'conference', page: 2 }));
  const published = await benchmarks.search(query({ publication: 'published' }));
  const journals = await benchmarks.search(query({ publication: 'journal' }));
  assert.deepEqual(all.results.map(result => result.publication.kind), ['conference', 'journal', 'preprint']);
  assert.deepEqual(all.results.map(result => result.publication.published), [true, true, false]);
  assert.equal(urls[1].searchParams.get('filter'), 'type:conference-paper');
  assert.equal(urls[1].searchParams.get('page'), '2');
  assert.equal(urls[2].searchParams.get('filter'), 'type:article|conference-paper|book-chapter|review|data-paper|software-paper,primary_location.is_published:true');
  assert.match(urls[3].searchParams.get('filter')!, /primary_location.source.type:journal/);
  assert.equal(conferences.total, 77);
  assert.deepEqual(conferences.results.map(result => result.publication.kind), ['conference']);
  assert.equal(published.results[0].paper.pdfUrl, conference.primary_location!.pdf_url);
  assert.equal(published.results[0].paper.venue, 'Synthetic workshop proceedings');
  assert.equal(journals.results[0].publication.kind, 'journal');
  assert.ok(all.results.every(result => result.publicationDate));
});

test('offline publication filters reuse known publication evidence and exclude unknown local records', async t => {
  const publishedRecords: OpenAlexWork[] = [
    { ...records[0], type: 'conference-paper', primary_location: { is_published: true } },
    { ...records[1], type: 'article', primary_location: { source: { type: 'journal' }, is_published: true } },
    { ...records[2], display_name: 'Defects4J preprint', type: 'preprint' },
  ];
  const { cache, benchmarks, directory } = await setup(t, async () => Response.json({ results: publishedRecords, meta: { count: 3 } }));
  await benchmarks.search(query());
  await cache.set('paper:W4', { paper: normalizeWork(work(4, 'Defects4J unknown publication', 2025)), meta: { source: 'live', fetchedAt: new Date().toISOString() } });
  const offline = new BenchmarkService(new PaperService(new PersistentCache(directory), true));
  const conference = await offline.search(query({ publication: 'conference' }));
  assert.deepEqual(conference.results.map(result => result.paper.id), ['W1']);
  assert.deepEqual((await offline.search(query({ publication: 'journal' }))).results.map(result => result.paper.id), ['W2']);
  assert.deepEqual((await offline.search(query({ publication: 'published' }))).results.map(result => result.paper.id), ['W1', 'W2']);
  assert.match(conference.meta.warning!, /without publication metadata/);
});

test('arbitrary benchmark names are extracted from evaluation evidence without a registry', () => {
  const matches = discoverBenchmarks({ kind: 'abstract', text: 'We evaluate on NebulaBench and AuroraSet benchmarks.', url: 'https://example.org/paper' });
  assert.deepEqual(matches.map(match => match.name), ['NebulaBench', 'AuroraSet']);
  assert.ok(matches.every(match => match.url === null && match.evidence.excerpt.includes(match.name)));
});

test('paper benchmark API dispatches by ID, validates providers and preserves metadata provenance', async t => {
  const { service } = await setup(t, async input => {
    assert.equal(new URL(String(input)).pathname, '/works/W99');
    return Response.json(work(99, 'Synthetic evaluation paper', 2026, 'We evaluate on MBPP and HumanEval benchmarks.'));
  });
  const s2Id = `S2:${'1'.repeat(40)}`;
  const s2Paper = { ...normalizeWork(work(1, 'Synthetic evaluation paper', null, 'We evaluate on NebulaBench benchmark.')), id: s2Id };
  await service.cache.set(`s2:paper:v1:${s2Id}`, { paper: s2Paper, meta: { provider: 'semantic-scholar', source: 'live', fetchedAt: new Date().toISOString() } });
  const semantic = new SemanticService(service.cache, true);
  const calls: string[] = [];
  const paper = semantic.paper.bind(semantic);
  semantic.paper = async (id, signal) => { calls.push(id); return paper(id, signal); };
  await service.paper('W99');
  const offline = new PaperService(service.cache, true, service.provider);
  await offline.ready;
  const server = createApp({ service: offline, semanticService: semantic, rateLimit: 1000 }).app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/paper`;
  for (const path of ['W0/benchmarks', 'bad/benchmarks', 'W99/benchmarks?provider=semantic-scholar', `${s2Id}/benchmarks?provider=openalex`, 'W99/benchmarks?provider=unknown']) {
    assert.equal((await fetch(`${base}/${path}`)).status, 400, path);
  }
  const response = await fetch(`${base}/W99/benchmarks`);
  assert.equal(response.status, 200);
  const body = PaperBenchmarksResponseSchema.parse(await response.json());
  assert.deepEqual(body.benchmarks.map(benchmark => benchmark.name), ['MBPP', 'HumanEval']);
  assert.deepEqual(body.coverage.fields, ['title', 'abstract']);
  assert.equal(body.coverage.discovery.status, 'unavailable');
  assert.equal(body.meta.provider, 'openalex');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const s2 = await fetch(`${base}/${s2Id}/benchmarks`);
  assert.equal(s2.status, 200);
  const s2Body = PaperBenchmarksResponseSchema.parse(await s2.json());
  assert.equal(s2Body.meta.provider, 'semantic-scholar');
  assert.deepEqual(s2Body.coverage.fields, ['title', 'abstract']);
  assert.deepEqual(s2Body.benchmarks.map(benchmark => benchmark.name), ['NebulaBench']);
  assert.deepEqual(calls, [s2Id]);
});
