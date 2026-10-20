import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CandidatePoolSchema, GraphResponseSchema, PaperResponseSchema, SearchResponseSchema } from '../shared/schemas.ts';
import { doiIdentifier } from '../shared/identifiers.ts';
import type { DataMeta, Paper } from '../shared/types.ts';
import { PersistentCache } from './cache.ts';
import { ALGORITHM, buildGraph } from './graph.ts';
import { ApiError } from './service.ts';
import { SemanticService } from './semantic-service.ts';
import { normalizeSemanticPaper, semanticId, semanticLookup, SemanticScholarError, SemanticScholarProvider,
  S2_FIELDS, S2_FULL_FIELDS, S2_ORIGIN, type SemanticPaper } from './semantic-scholar.ts';

const sha = (n: number) => n.toString(16).padStart(40, '0');
const id = (n: number) => `S2:${sha(n)}`;
const oldTime = '2001-01-01T00:00:00.000Z';
const meta: DataMeta = { provider: 'semantic-scholar', source: 'live', fetchedAt: oldTime };
const record = (n: number, refs?: number[]): SemanticPaper => ({ paperId: sha(n), title: `Actual fixture ${n}`,
  ...(refs ? { references: refs.map(n => ({ paperId: sha(n) })) } : {}) });
const paper = (n: number, refs?: number[]) => normalizeSemanticPaper(record(n, refs));
const pool = (n: number, papers: Paper[] = [paper(n)]) => ({ origin: id(n), papers, ...meta, coverage: 'Exact-origin fixture neighborhood.' });
const graphMeta = { ...meta, candidateCount: 1, algorithm: ALGORITHM, coverage: 'Exact-origin fixture' };

async function setup(t: TestContext, maxEntries = 128) {
  const directory = await mkdtemp(join(tmpdir(), 'semantic-scholar-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, cache: new PersistentCache(directory, maxEntries) };
}

test('canonical IDs and safe aliases include public S2 URLs, DOI and modern/legacy arXiv IDs', () => {
  assert.equal(semanticId(sha(1).toUpperCase()), id(1));
  assert.equal(semanticId(`s2:${'A'.repeat(40)}`), `S2:${'a'.repeat(40)}`);
  for (const alias of [sha(1), id(1), `https://www.semanticscholar.org/paper/${sha(1)}`,
    `https://semanticscholar.org/paper/Some-Title-Author/${sha(1)}/`]) assert.equal(semanticLookup(alias), sha(1));
  for (const alias of ['10.1234/Test/Thing', 'DOI:10.1234/Test/Thing', 'https://doi.org/10.1234/Test/Thing']) {
    assert.equal(semanticLookup(alias), 'DOI:10.1234/test/thing');
  }
  for (const alias of ['arXiv:1706.03762v2', '1706.03762', 'https://arxiv.org/abs/1706.03762v3', 'https://arxiv.org/pdf/1706.03762.pdf']) {
    assert.equal(semanticLookup(alias), 'ARXIV:1706.03762');
  }
  assert.equal(semanticLookup('hep-th/9901001'), 'ARXIV:hep-th/9901001');
  for (const alias of ['W1', 'S2:abc', '//evil.example/paper', 'https://evil.example/paper/' + sha(1),
    'URL:https://arxiv.org/abs/1706.03762', 'https://user:secret@semanticscholar.org/paper/' + sha(1),
    'https://semanticscholar.org:8080/paper/' + sha(1), 'https://arxiv.org.evil/abs/1706.03762',
    'https://arxiv.org/not-abs/1706.03762', 'DOI:10.1234/a\n']) {
    assert.equal(semanticLookup(alias), null, alias);
  }
});

test('encoded Semantic Scholar DOI URLs export the original identifier exactly once', () => {
  for (const doi of ['10.1234/a:b', '10.1002/(SICI)1234<5::AID-TEST>3.0.CO;2-1', '10.1234/a%25b']) {
    const normalized = normalizeSemanticPaper({ ...record(1), externalIds: { DOI: doi } });
    assert.equal(doiIdentifier(normalized.doi!), doi);
  }
  assert.equal(doiIdentifier('10.1234/a:b'), '10.1234/a:b');
  assert.equal(doiIdentifier('https://doi.org/10.1234/a%invalid'), '10.1234/a%invalid');
});

test('normalization uses returned metadata and canonical references without recommendations or invented titles', () => {
  const normalized = normalizeSemanticPaper({ ...record(1), title: 'Returned title', authors: [{ name: 'Real author' }],
    abstract: 'Returned abstract', year: 2024, venue: 'Returned venue', citationCount: 9,
    references: [{ paperId: sha(2) }, { paperId: sha(2) }, { paperId: sha(1) }, { paperId: null }],
    externalIds: { DOI: '10.1234/test' }, url: 'javascript:alert(1)', openAccessPdf: { url: 'data:text/html,evil' },
    isOpenAccess: true, fieldsOfStudy: ['Physics'] });
  assert.equal(PaperResponseSchema.safeParse({ paper: normalized, meta }).success, true);
  assert.deepEqual(normalized, { id: id(1), title: 'Returned title', authors: ['Real author'], year: 2024,
    venue: 'Returned venue', citations: 9, references: [id(2)], abstract: 'Returned abstract', doi: 'https://doi.org/10.1234/test',
    url: `https://www.semanticscholar.org/paper/${sha(1)}`, pdfUrl: null, openAccess: true, topics: ['Physics'] });
  assert.deepEqual(paper(1).references, []);
  assert.equal(paper(1).year, null);
  assert.equal(paper(1).abstract, '');
  assert.throws(() => normalizeSemanticPaper({ paperId: sha(1) }), /Invalid.*metadata/);
  assert.throws(() => normalizeSemanticPaper({ ...record(1), references: [null] } as unknown as SemanticPaper), /Invalid/);
  assert.throws(() => normalizeSemanticPaper({ ...record(1), citationCount: -1 }), /Invalid/);
});

test('official transport deduplicates, uses server-only x-api-key and restores object provenance from cache', async t => {
  const { directory, cache } = await setup(t);
  let calls = 0;
  const provider = new SemanticScholarProvider({ cache, apiKey: 'private-test-key', fetch: async (input, options) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.origin, S2_ORIGIN);
    assert.equal(url.pathname, `/graph/v1/paper/${sha(1)}`);
    assert.equal(url.searchParams.get('fields'), S2_FULL_FIELDS);
    assert.equal(options?.redirect, 'error');
    assert.equal(options?.method, 'GET');
    assert.equal((options?.headers as Record<string, string>)['x-api-key'], 'private-test-key');
    assert.ok(!url.href.includes('private-test-key'));
    return Response.json(record(1));
  } });
  const records = await Promise.all(Array.from({ length: 8 }, () => provider.getPaper(id(1))));
  assert.equal(calls, 1);
  assert.equal(provider.metadata(records[0]).provider, 'semantic-scholar');
  const date = provider.metadata(records[0]).fetchedAt;
  const expiry = provider.expiresAt(records[0]);
  const restarted = new SemanticScholarProvider({ cache: new PersistentCache(directory), offline: true,
    fetch: async () => { throw new Error('Must not fetch'); } });
  const stored = await restarted.getPaper(id(1));
  assert.equal(restarted.metadata(stored).source, 'cache');
  assert.equal(restarted.metadata(stored).fetchedAt, date);
  assert.equal(restarted.expiresAt(stored), expiry);
  assert.match(restarted.metadata(stored).warning!, /not blanket CC0/);
  assert.ok(!(await readFile(`${directory}/openalex-cache-v1.json`, 'utf8')).includes('private-test-key'));
  for (const invalid of ['https://evil.test/graph/v1/paper/' + sha(1), '../../secret', 'URL:https://evil.test', 'W1']) {
    await assert.rejects(provider.getPaper(invalid), e => e instanceof SemanticScholarError && e.status === 400);
  }
  assert.equal(calls, 1);
});

test('search pagination reports genuine upstream totals, validates offsets, and empty pages retain provenance', async t => {
  const { cache } = await setup(t);
  const offsets: number[] = [];
  const provider = new SemanticScholarProvider({ cache, fetch: async input => {
    const url = new URL(String(input)), offset = Number(url.searchParams.get('offset'));
    assert.equal(url.pathname, '/graph/v1/paper/search');
    assert.equal(url.searchParams.get('limit'), '20');
    assert.equal(url.searchParams.get('fields'), S2_FULL_FIELDS);
    offsets.push(offset);
    return Response.json({ offset, total: 12345, data: offset < 40 ? Array.from({ length: 20 }, (_, i) => record(offset + i + 1)) : [] });
  } });
  const service = new SemanticService(cache, false, provider);
  const first = await service.search('fixture', 1), second = await service.search('fixture', 2), empty = await service.search('fixture', 3);
  assert.deepEqual(offsets, [0, 20, 40]);
  assert.equal(first.total, 12345);
  assert.equal(second.total, first.total);
  assert.equal(second.page, 2);
  assert.equal(second.perPage, 20);
  assert.ok(second.results.every(p => !first.results.some(q => p.id === q.id)));
  assert.equal(empty.results.length, 0);
  assert.equal(empty.meta.provider, 'semantic-scholar');
  assert.equal(empty.meta.source, 'live');
  assert.match(empty.meta.warning!, /approximate.*1,000/);
  assert.equal(SearchResponseSchema.safeParse(empty).success, true);
  await assert.rejects(service.search('fixture', 51), e => e instanceof ApiError && e.status === 400 && /narrow.*query/.test(e.message));
  assert.deepEqual(offsets, [0, 20, 40]);
});

test('identifier search resolves safely encoded DOI segments and aliases, including page two', async t => {
  const { cache } = await setup(t);
  const paths: string[] = [];
  const provider = new SemanticScholarProvider({ cache, fetch: async input => {
    const url = new URL(String(input)); paths.push(url.pathname);
    assert.equal(url.origin, S2_ORIGIN);
    assert.equal(url.pathname.split('/').length, 5, 'DOI slashes must remain inside one encoded segment');
    return Response.json(url.pathname.endsWith(sha(2)) ? record(2) : { ...record(1), externalIds: { DOI: '10.1234/test/thing' } });
  } });
  const service = new SemanticService(cache, false, provider);
  const doi = await service.search('https://doi.org/10.1234/Test/Thing', 1);
  assert.equal(doi.results[0].id, id(1));
  assert.equal(paths[0], '/graph/v1/paper/DOI%3A10.1234%2Ftest%2Fthing');
  assert.equal((await service.search('DOI:10.1234/test/thing', 2)).total, 1);
  assert.deepEqual((await service.search('DOI:10.1234/test/thing', 2)).results, []);
  const bySha = await service.search(sha(1), 1);
  assert.equal(bySha.results[0].id, id(1));
  assert.equal(bySha.meta.source, 'cache');
  assert.equal((await service.search(id(1), 1)).results[0].id, id(1));
  assert.equal((await service.search(`https://www.semanticscholar.org/paper/Title/${sha(1)}`, 1)).results[0].id, id(1));
  assert.equal((await service.search(sha(2), 1)).results[0].id, id(2));
  const arxiv = await service.search('arxiv:1706.03762', 1);
  assert.equal(arxiv.results[0].id, id(1));
  assert.ok(paths.includes('/graph/v1/paper/ARXIV%3A1706.03762'));
  assert.equal(paths.length, 3);
});

test('POST batch is bounded to 100/request and 300 overall, skips nulls and preserves oldest metadata', async t => {
  const { cache } = await setup(t);
  const sizes: number[] = [], dates: string[] = [];
  const provider = new SemanticScholarProvider({ cache, fetch: async (input, options) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, '/graph/v1/paper/batch');
    assert.equal(options?.method, 'POST');
    assert.equal(url.searchParams.get('fields'), S2_FULL_FIELDS);
    assert.equal((options?.headers as Record<string, string>)['Content-Type'], 'application/json');
    const ids = JSON.parse(options!.body as string).ids as string[];
    sizes.push(ids.length); dates.push(new Date().toISOString());
    return Response.json(ids.map((hash, i) => i === 0 ? null : { paperId: hash, title: hash, references: [] }));
  } });
  const records = await provider.batch(Array.from({ length: 401 }, (_, n) => id(n + 1)));
  assert.deepEqual(sizes, [100, 100, 100]);
  assert.equal(records.length, 297);
  assert.equal(provider.metadata(records).fetchedAt, provider.metadata(records[0]).fetchedAt);
  assert.ok(provider.metadata(records).fetchedAt <= dates[1]);
  assert.equal(provider.metadata(records).provider, 'semantic-scholar');
  assert.equal(provider.metadata(records[records.length - 1]).fetchedAt, provider.metadata(records).fetchedAt);
  await assert.rejects(provider.batch(['W1']), e => e instanceof SemanticScholarError && e.status === 400);
});

test('429 has no retries, honors Retry-After with a 60-second minimum and suppresses queued traffic', async t => {
  for (const retry of ['1', '120', new Date(Date.now() + 180000).toUTCString(), 'invalid']) {
    const { cache } = await setup(t);
    let calls = 0;
    const provider = new SemanticScholarProvider({ cache, apiKey: `private-rate-key-${retry}`, fetch: async () => {
      calls++; return new Response('private-rate-key upstream details', { status: 429, headers: { 'Retry-After': retry } });
    } });
    const results = await Promise.allSettled([provider.getPaper(id(1)), provider.getPaper(id(2))]);
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') {
        assert.ok(result.reason instanceof SemanticScholarError);
        assert.equal(result.reason.status, 429);
        assert.ok((result.reason.retryAfter ?? 0) >= (retry === '120' ? 119 : 59));
        assert.ok(!result.reason.message.includes('private-rate-key'));
      }
    }
    await assert.rejects(provider.getPaper(id(3)), e => e instanceof SemanticScholarError && e.status === 429);
    assert.equal(calls, 1);
    assert.deepEqual(await cache.list('s2:raw:'), []);
  }
});

test('failed lease release preserves terminal 404 but fails closed for other transport outcomes', async t => {
  for (const status of [404, 429, 503, 200]) {
    const { cache } = await setup(t);
    let calls = 0, releases = 0;
    const provider = new SemanticScholarProvider({ cache, rateLimiter: { reserve: async () => ({
      assertValid() {}, release: async () => { releases++; throw new Error('Private cleanup detail'); },
    }) }, fetch: async () => {
      calls++;
      return status === 200 ? Response.json(record(1)) : new Response('Private upstream detail', { status });
    } });
    await assert.rejects(provider.getPaper(id(1)), e => e instanceof SemanticScholarError &&
      e.status === (status === 404 ? 404 : 503) && !e.message.includes('Private'));
    assert.equal(calls, 1);
    assert.equal(releases, 1);
  }
});

test('one active transport and queue <=16; queued/pacing cancellation shares the 12-second transport deadline', async t => {
  const { cache } = await setup(t);
  let active = 0, maximum = 0;
  const paths: string[] = [];
  const provider = new SemanticScholarProvider({ cache, timeoutMs: 90, fetch: async (input, options) => {
    paths.push(new URL(String(input)).pathname); active++; maximum = Math.max(maximum, active);
    try { await delay(10000, undefined, { signal: options!.signal! }); }
    finally { active--; }
    return Response.json(record(1));
  } });
  const start = Date.now();
  const responses = await Promise.allSettled(Array.from({ length: 18 }, (_, n) => provider.getPaper(id(n + 1))));
  assert.ok(Date.now() - start < 600);
  assert.equal(maximum, 1); assert.equal(active, 0); assert.equal(paths.length, 1);
  assert.ok(responses.every(r => r.status === 'rejected'));
  assert.ok(responses.some(r => r.status === 'rejected' && /queue is full/.test(r.reason.message)));
  assert.equal((await cache.list('s2:raw:')).length, 0);
});

test('successful requests start no faster than one per second; a queued aborted request never fetches', async t => {
  const { cache } = await setup(t);
  const starts: number[] = [], paths: string[] = [];
  const provider = new SemanticScholarProvider({ cache, fetch: async input => {
    const url = new URL(String(input)); starts.push(Date.now()); paths.push(url.pathname);
    return Response.json({ paperId: url.pathname.split('/').pop(), title: 'Returned paper' });
  } });
  await provider.getPaper(id(1));
  const cancelled = new AbortController();
  const skipped = assert.rejects(provider.getPaper(id(2), cancelled.signal));
  const survivor = provider.getPaper(id(3));
  await delay(20); cancelled.abort();
  await skipped; await survivor;
  assert.deepEqual(paths, [`/graph/v1/paper/${sha(1)}`, `/graph/v1/paper/${sha(3)}`]);
  assert.ok(starts[1] - starts[0] >= 990);
});

test('raw JSON shapes, wrong identities, redirects/transport failures, and oversized bodies fail closed', async t => {
  for (const payload of [null, { ...record(1), authors: [null] }, { ...record(1), references: ['bad'] },
    { ...record(1), abstract: {} }, record(2)]) {
    const { cache } = await setup(t);
    const provider = new SemanticScholarProvider({ cache, fetch: async () => Response.json(payload) });
    await assert.rejects(provider.getPaper(id(1)), e => e instanceof SemanticScholarError && e.status === 502);
    assert.deepEqual(await cache.list('s2:raw:'), []);
  }
  const { cache } = await setup(t);
  const restricted = new SemanticScholarProvider({ cache, fetch: async () => { throw new Error('Must not fetch'); } });
  const rawRequest = restricted as unknown as { request: (path: string, params: Record<string, string>, schema: unknown, validate: unknown) => Promise<unknown> };
  for (const path of ['https://evil.test/graph/v1/paper/' + sha(1), '//evil.test/paper', '/graph/v1/paper/..',
    '/graph/v1/paper/%2E%2E', '/graph/v1/paper/URL%3Ahttps%3A%2F%2Fevil.test', '/graph/v1/paper/recommendations']) {
    await assert.rejects(rawRequest.request(path, {}, null, null), e => e instanceof SemanticScholarError && e.status === 400);
  }
  const badPage = new SemanticScholarProvider({ cache, fetch: async () => Response.json({ total: 10, offset: 20, data: [] }) });
  await assert.rejects(badPage.search('fixture', 1), /Invalid.*response/);
  const badBatch = new SemanticScholarProvider({ cache, fetch: async () => Response.json([record(2)]) });
  await assert.rejects(badBatch.batch([id(1)]), /Invalid.*response/);
  const unsafe = new SemanticScholarProvider({ cache, fetch: async (_input, options) => {
    assert.equal(options?.redirect, 'error'); throw new Error('redirect or private-api-key error');
  } });
  await assert.rejects(unsafe.getPaper(id(1)), e => e instanceof SemanticScholarError && !e.message.includes('private-api-key'));
  let cancelled = false;
  const oversized = new SemanticScholarProvider({ cache, fetch: async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(12 * 1024 * 1024 + 1)); }, cancel() { cancelled = true; },
  })) });
  await assert.rejects(oversized.getPaper(id(1)), /size limit/);
  assert.equal(cancelled, true);
  const badJson = new SemanticScholarProvider({ cache, fetch: async () => new Response('{private-malformed-json') });
  await assert.rejects(badJson.getPaper(id(1)), /Semantic Scholar is unavailable/);
});

test('body reading is cancelled at the transport deadline, not just fetching headers', async t => {
  const { cache } = await setup(t);
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  let cancelled = false;
  const provider = new SemanticScholarProvider({ cache, timeoutMs: 40, fetch: async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; },
  })) });
  await assert.rejects(provider.getPaper(id(1)), /unavailable/);
  assert.equal(cancelled, true);
  assert.equal((await cache.list('s2:raw:')).length, 0);
});

test('sample collection uses documented BasePaper fields then hydrates outgoing references for exact citation edges', async t => {
  const { cache } = await setup(t);
  const calls: string[] = [];
  const records = new Map([record(1, [10]), record(2, [10]), record(3, [1, 2]), record(10, [])].map(p => [p.paperId, p]));
  const provider = new SemanticScholarProvider({ cache, fetch: async (input, options) => {
    const url = new URL(String(input)); calls.push(url.pathname);
    if (url.pathname.endsWith('/batch')) {
      assert.equal(url.searchParams.get('fields'), S2_FULL_FIELDS);
      const ids = JSON.parse(options!.body as string).ids as string[];
      return Response.json(ids.map(id => records.get(id) ?? null));
    }
    if (url.pathname.endsWith('/references')) {
      assert.equal(url.searchParams.get('fields'), S2_FIELDS);
      assert.equal(url.searchParams.get('limit'), '80');
      return Response.json({ offset: 0, data: [{ citedPaper: record(10) }, { citedPaper: { paperId: null, title: 'Unknown reference' } }] });
    }
    if (url.pathname.endsWith('/citations')) {
      assert.equal(url.searchParams.get('fields'), S2_FIELDS);
      assert.equal(url.searchParams.get('limit'), '100');
      return Response.json({ offset: 0, data: [{ citingPaper: record(3) }] });
    }
    return Response.json(records.get(sha(1)));
  } });
  const graph = await new SemanticService(cache, false, provider).graph([id(1)]);
  assert.equal(graph.meta.provider, 'semantic-scholar');
  assert.equal(graph.meta.algorithm, ALGORITHM);
  assert.equal(graph.meta.candidateCount, 4);
  assert.equal(graph.nodes.length, 4, 'The origin\'s direct reference and citer are shown even without similarity evidence');
  assert.deepEqual(graph.edges.filter(e => e.directCitation).map(e => [e.source, e.target].sort()).sort(), [[id(1), id(10)], [id(1), id(3)]].map(p => p.sort()).sort());
  const edge = graph.edges.find(e => !e.directCitation)!;
  assert.deepEqual([edge.source, edge.target].sort(), [id(1), id(2)]);
  assert.equal(edge.sharedReferences, 1);
  assert.equal(edge.coCitations, 1);
  assert.equal(edge.weight, 1);
  assert.equal(graph.prior[0].id, id(10));
  assert.equal(graph.derivative[0].id, id(3));
  assert.equal(graph.derivative[0].graphConnections, 2);
  assert.match(graph.meta.coverage, /order is unspecified, not citation-ranked/);
  assert.match(graph.meta.coverage, /missing references.*empty arrays/);
  assert.equal(GraphResponseSchema.safeParse(graph).success, true);
  assert.equal(CandidatePoolSchema.safeParse((await cache.get(`s2:pool:v1:${id(1)}`))!.value).success, true);
  assert.deepEqual(calls, [`/graph/v1/paper/${sha(1)}`, `/graph/v1/paper/${sha(1)}/references`,
    '/graph/v1/paper/batch', `/graph/v1/paper/${sha(1)}/citations`, '/graph/v1/paper/batch', '/graph/v1/paper/batch']);
  assert.ok(calls.every(p => p.startsWith('/graph/v1/paper/')));
});

test('empty collection pages retain oldest returned-object provenance without an acquisition log', async t => {
  const { cache } = await setup(t);
  const provider = new SemanticScholarProvider({ cache });
  const origin = record(1, []), refs = { offset: 0, data: [] }, citers = { offset: 0, data: [] };
  provider.getPaper = async () => origin;
  provider.references = async () => refs;
  provider.citations = async () => citers;
  provider.batch = async () => [];
  provider.metadata = data => ({ provider: 'semantic-scholar', source: data === origin ? 'cache' : 'live',
    fetchedAt: data === refs ? oldTime : '2020-01-01T00:00:00.000Z' });
  provider.expiresAt = () => Date.now() + 60000;
  const graph = await new SemanticService(cache, false, provider).graph([id(1)]);
  assert.equal(graph.meta.source, 'live');
  assert.equal(graph.meta.fetchedAt, oldTime);
  assert.equal(graph.nodes.length, 1);
  assert.deepEqual(graph.edges, []);
});

test('S2 cache hydration rejects OpenAlex/mixed/malformed entries and never fetches in offline mode', async t => {
  const { directory, cache } = await setup(t);
  const oa = { ...paper(1), id: 'W1', references: [], url: 'https://openalex.org/W1' };
  await cache.set('paper:W1', { paper: oa, meta: { source: 'cache', fetchedAt: oldTime } });
  await cache.set(`s2:paper:v1:${id(1)}`, { paper: oa, meta });
  await cache.set(`s2:paper:v1:${id(2)}`, { paper: paper(2), meta: { ...meta, provider: 'openalex' } });
  await cache.set(`s2:paper:v1:${id(3)}`, { paper: { ...paper(3), references: ['W1'] }, meta });
  await cache.set(`s2:paper:v1:${id(4)}`, { paper: paper(5), meta });
  await cache.set(`s2:paper:v1:${id(6)}`, { paper: null, meta });
  await cache.set(`s2:pool:v1:${id(7)}`, { ...pool(7), papers: [paper(7), oa] });
  await cache.set(`s2:pool:v1:${id(8)}`, { ...pool(8), provider: undefined });
  await cache.set('s2:search:v1:1:mixed', { results: [oa], total: 1, page: 1, perPage: 20, meta });
  await cache.set('s2:search:v1:1:wrong-page', { results: [paper(9)], total: 1, page: 2, perPage: 20, meta });
  await cache.set(`s2:graph:v1:${id(7)}`, { ...buildGraph([paper(7)], [id(7)], graphMeta), meta: { ...graphMeta, provider: 'openalex' } });
  let calls = 0;
  const restarted = new PersistentCache(directory);
  const provider = new SemanticScholarProvider({ cache: restarted, fetch: async () => { calls++; throw new Error('Offline traffic'); } });
  const service = new SemanticService(restarted, true, provider);
  await service.ready;
  for (const n of [1, 2, 3, 4, 6, 7, 8, 9]) {
    await assert.rejects(service.paper(id(n)), e => e instanceof ApiError && e.status === 503 && /S2_API_KEY.*No other data/.test(e.message));
  }
  await assert.rejects(service.search('mixed', 1), /no matching Semantic Scholar cache/);
  await assert.rejects(service.graph([id(7)]), /no matching Semantic Scholar cache/);
  assert.equal(calls, 0);
});

test('expired normalized paper/search/pools preserve timestamps and expiry on warned outage fallback', async t => {
  const { directory, cache } = await setup(t);
  await cache.set(`s2:pool:v1:${id(1)}`, pool(1), -1);
  await cache.set(`s2:paper:v1:${id(2)}`, { paper: paper(2), meta }, -1);
  await cache.set('s2:search:v1:1:fixture', { results: [paper(3)], total: 100, page: 1, perPage: 20, meta }, -1);
  const expiry = (await cache.get(`s2:paper:v1:${id(2)}`, true))!.expiresAt;
  const restarted = new PersistentCache(directory);
  const provider = new SemanticScholarProvider({ cache: restarted, fetch: async () => new Response('', { status: 503 }) });
  const service = new SemanticService(restarted, false, provider);
  const stalePaper = await service.paper(id(2));
  assert.equal(stalePaper.meta.fetchedAt, oldTime);
  assert.match(stalePaper.meta.warning!, /unavailable.*stale/);
  const staleSearch = await service.search('fixture', 1);
  assert.equal(staleSearch.total, 100);
  assert.equal(staleSearch.meta.fetchedAt, oldTime);
  assert.match(staleSearch.meta.warning!, /stale cached/);
  const staleGraph = await service.graph([id(1)]);
  assert.equal(staleGraph.meta.fetchedAt, oldTime);
  assert.match(staleGraph.meta.warning!, /unavailable.*stale/);
  assert.equal(await restarted.get(`s2:graph:v1:${id(1)}`), undefined);
  assert.equal((await restarted.get(`s2:paper:v1:${id(2)}`, true))!.expiresAt, expiry);
  const offline = new SemanticService(new PersistentCache(directory), true);
  assert.equal((await offline.search(id(2), 1)).results[0].id, id(2));
  assert.equal((await offline.paper(id(2))).meta.fetchedAt, oldTime);
});

test('offline identifier lookup requires exact ID/DOI matches, not title tokens from unrelated S2 metadata', async t => {
  const { cache } = await setup(t);
  await cache.set(`s2:paper:v1:${id(1)}`, { paper: { ...paper(1), title: '10 1234 requested', doi: 'https://doi.org/10.1234/other' }, meta });
  await cache.set(`s2:paper:v1:${id(2)}`, { paper: { ...paper(2), doi: 'https://doi.org/10.1234/requested' }, meta });
  const service = new SemanticService(cache, true);
  assert.equal((await service.search('DOI:10.1234/requested', 1)).results[0].id, id(2));
  assert.equal((await service.search('10.1234/requested', 2)).total, 1);
  assert.deepEqual((await service.search('10.1234/requested', 2)).results, []);
  await assert.rejects(service.search('10.1234/absent', 1), /no matching Semantic Scholar cache/);
  await assert.rejects(service.search('S2:1234', 1), e => e instanceof ApiError && e.status === 400);
});

test('expired inputs refresh online; stale raw cached inputs cannot acquire a renewed normalized TTL', async t => {
  const { cache } = await setup(t);
  await cache.set(`s2:paper:v1:${id(1)}`, { paper: paper(1), meta }, -1);
  let calls = 0;
  const liveProvider = new SemanticScholarProvider({ cache, fetch: async () => { calls++; return Response.json(record(1, [])); } });
  const fresh = await new SemanticService(cache, false, liveProvider).paper(id(1));
  assert.equal(calls, 1); assert.notEqual(fresh.meta.fetchedAt, oldTime);
  const { cache: staleCache } = await setup(t);
  const producer = new SemanticScholarProvider({ cache: staleCache, fetch: async () => Response.json(record(2)) });
  await producer.getPaper(id(2));
  const raw = (await staleCache.list<unknown>('s2:raw:v1:'))[0];
  const envelope = raw.value as { data: SemanticPaper; meta: DataMeta };
  await staleCache.set(raw.key, { ...envelope, meta }, -1);
  const offlineProvider = new SemanticScholarProvider({ cache: staleCache, offline: true });
  const stale = await new SemanticService(staleCache, false, offlineProvider).paper(id(2));
  assert.equal(stale.meta.fetchedAt, oldTime);
  assert.match(stale.meta.warning!, /stale cached/);
  assert.equal(await staleCache.get(`s2:paper:v1:${id(2)}`), undefined);
});

test('fresh exact-origin pools and graphs avoid traffic; offline reorigin and multi-origin disclose containing pools', async t => {
  const { directory, cache } = await setup(t);
  const papers = [paper(1, [10]), paper(2, [10]), paper(3, [1, 2]), paper(10, [])];
  await cache.set(`s2:pool:v1:${id(1)}`, pool(1, papers));
  await cache.set(`s2:pool:v1:${id(20)}`, pool(20, [paper(20, [21]), paper(21, [])]));
  let calls = 0;
  const provider = new SemanticScholarProvider({ cache, fetch: async () => { calls++; throw new Error('Unexpected traffic'); } });
  const service = new SemanticService(cache, false, provider);
  const graph = await service.graph([id(1)]);
  assert.equal(graph.meta.source, 'cache'); assert.equal(graph.meta.fetchedAt, oldTime);
  assert.equal((await service.graph([id(1)])).meta.fetchedAt, oldTime);
  assert.equal(calls, 0);
  const offline = new SemanticService(new PersistentCache(directory), true, provider);
  const reorigin = await offline.graph([id(2)]);
  assert.equal(reorigin.nodes.find(p => p.id === id(2))!.isOrigin, true);
  assert.match(reorigin.meta.coverage, /Containing pool.*no origin-specific neighborhood/);
  assert.match(reorigin.meta.warning!, /Offline/);
  assert.equal(await cache.get(`s2:graph:v1:${id(2)}`), undefined);
  const multi = await offline.graph([id(2), id(20), id(1)]);
  assert.equal(multi.nodes.filter(p => p.isOrigin).length, 3);
  assert.equal(multi.meta.fetchedAt, oldTime);
  assert.equal(GraphResponseSchema.safeParse(multi).success, true);
  assert.equal(calls, 0);
});

test('live reorigin cannot be suppressed by fresh containing-pool or wrong-origin graph caches', async t => {
  const { cache } = await setup(t);
  await cache.set(`s2:pool:v1:${id(1)}`, pool(1, [paper(1, [10]), paper(2, [10])]));
  await cache.set(`s2:graph:v1:${id(2)}`, buildGraph([paper(2)], [id(2)], graphMeta));
  const provider = new SemanticScholarProvider({ cache });
  const expansions: string[] = [];
  provider.getPaper = async lookup => { expansions.push(`paper:${lookup}`); return record(2, []); };
  provider.references = async lookup => { expansions.push(`refs:${lookup}`); return { offset: 0, data: [] }; };
  provider.citations = async lookup => { expansions.push(`citers:${lookup}`); return { offset: 0, data: [] }; };
  provider.batch = async () => [];
  const result = await new SemanticService(cache, false, provider).graph([id(2)]);
  assert.deepEqual(expansions, [`paper:${id(2)}`, `refs:${id(2)}`, `citers:${id(2)}`]);
  assert.equal(result.meta.source, 'live');
  assert.equal(result.meta.candidateCount, 1);
  assert.ok(!result.meta.coverage.includes('Containing pool'));
});

test('shared search consumer cancellation preserves survivor; all graph consumers cancel transport and writes', async t => {
  const { cache } = await setup(t);
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  let calls = 0, aborted = 0;
  const provider = new SemanticScholarProvider({ cache, fetch: async (_input, options) => {
    calls++; entered();
    await new Promise<void>((resolve, reject) => {
      const cancel = () => { aborted++; reject(options!.signal!.reason); };
      options!.signal!.addEventListener('abort', cancel, { once: true });
      void blocked.then(() => { options!.signal!.removeEventListener('abort', cancel); resolve(); });
    });
    return Response.json({ offset: 0, total: 1, data: [record(1)] });
  } });
  const service = new SemanticService(cache, false, provider);
  const a = new AbortController(), b = new AbortController();
  const first = assert.rejects(service.search('shared', 1, a.signal), /cancelled consumer/);
  const second = service.search('shared', 1, b.signal);
  await started; a.abort(new Error('cancelled consumer'));
  await delay(10); assert.equal(aborted, 0); finish();
  await first; assert.equal((await second).results[0].id, id(1)); assert.equal(calls, 1);
  const { cache: allCache } = await setup(t);
  let active = 0, graphCalls = 0;
  const allProvider = new SemanticScholarProvider({ cache: allCache, fetch: async (_input, options) => {
    graphCalls++; active++;
    try { await delay(10000, undefined, { signal: options!.signal! }); }
    finally { active--; }
    return Response.json(record(2));
  } });
  const all = new SemanticService(allCache, false, allProvider);
  const c = new AbortController(), d = new AbortController();
  const operations = Promise.allSettled([all.graph([id(2)], c.signal), all.graph([id(2)], d.signal)]);
  await delay(10); assert.equal(active, 1); c.abort(); d.abort();
  assert.ok((await operations).every(r => r.status === 'rejected'));
  assert.equal(active, 0); assert.equal(graphCalls, 1);
  assert.deepEqual(await allCache.list('s2:pool:'), []);
  assert.deepEqual(await allCache.list('s2:graph:'), []);
  assert.deepEqual(await allCache.list('s2:raw:'), []);
});

test('whole-operation cancellation interrupts pacing and stops all later acquisition', async t => {
  const { cache } = await setup(t);
  let calls = 0;
  const provider = new SemanticScholarProvider({ cache, fetch: async () => { calls++; return Response.json(record(1)); } });
  await assert.rejects(new SemanticService(cache, false, provider).graph([id(1)], AbortSignal.timeout(80)));
  assert.equal(calls, 1);
  assert.equal(await cache.get(`s2:pool:v1:${id(1)}`, true), undefined);
  assert.equal(await cache.get(`s2:graph:v1:${id(1)}`, true), undefined);
});

test('unknown IDs return 404 online and uncached outages/offline return actionable 503, not OpenAlex records', async t => {
  const { cache } = await setup(t);
  const missing = new SemanticService(cache, false, new SemanticScholarProvider({ cache,
    fetch: async () => new Response('Private upstream details', { status: 404 }) }));
  await assert.rejects(missing.paper(id(1)), e => e instanceof ApiError && e.status === 404 && !e.message.includes('Private'));
  assert.equal((await missing.search(sha(1), 1)).total, 0);
  await assert.rejects(missing.graph([id(1)]), e => e instanceof ApiError && e.status === 404);
  const offline = new SemanticService(cache, true);
  await assert.rejects(offline.search('anything', 1), e => e instanceof ApiError && e.status === 503 && /S2_API_KEY.*No other data/.test(e.message));
  await assert.rejects(offline.paper('W1'), e => e instanceof ApiError && e.status === 400);
  await assert.rejects(offline.graph([id(1), id(1)]), e => e instanceof ApiError && e.status === 400);
  await assert.rejects(offline.graph(['W1']), e => e instanceof ApiError && e.status === 400);
});

test('hydration remains bounded to 12 pools and 4,000 normalized papers', async t => {
  const { cache } = await setup(t, 256);
  for (let group = 0; group < 14; group++) {
    const n = group * 300 + 1;
    await cache.set(`s2:pool:v1:${id(n)}`, pool(n, Array.from({ length: 300 }, (_, i) => paper(n + i))));
  }
  for (let n = 1; n <= 22; n++) {
    await cache.set(`s2:search:v1:1:fixture${n}`, { results: Array.from({ length: 20 }, (_, i) => paper(10000 + n * 20 + i)),
      page: 1, perPage: 20, total: 20, meta });
  }
  const service = new SemanticService(cache, true);
  await service.ready;
  const state = service as unknown as { papers: Map<string, unknown>; pools: Map<string, unknown> };
  assert.equal(state.papers.size, 4000);
  assert.equal(state.pools.size, 12);
  assert.ok(!state.pools.has(id(1)));
});
