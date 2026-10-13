import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GraphResponse, Paper, SearchResponse } from '../shared/types.ts';
import { PersistentCache } from './cache.ts';
import { buildGraph, ALGORITHM } from './graph.ts';
import { createApp } from './index.ts';
import { normalizeWork, OpenAlexProvider, OPENALEX_ORIGIN, ProviderError, type OpenAlexWork } from './openalex.ts';
import { ApiError, localSearch, PaperService } from './service.ts';
import { SemanticService } from './semantic-service.ts';
import { normalizeSemanticPaper, SemanticScholarProvider, S2_ORIGIN } from './semantic-scholar.ts';
import type { CandidatePool } from './collection.ts';

const snapshotText = await readFile(fileURLToPath(new URL('../data/snapshot.json', import.meta.url)), 'utf8');
const snapshot = JSON.parse(snapshotText) as { fetchedAt: string; examples: { id: string; field: string }[]; groups: CandidatePool[] };
const bundled = [...new Map(snapshot.groups.flatMap(g => g.papers).map(p => [p.id, p])).values()];
const meta: GraphResponse['meta'] = { source: 'snapshot', fetchedAt: snapshot.fetchedAt, candidateCount: 0, algorithm: ALGORITHM, coverage: 'Test fixture' };
const fixture = (id: string, references: string[] = [], topics: string[] = []): Paper => ({
  id, title: id, authors: [], year: 2020, venue: '', citations: 0, references, abstract: '',
  doi: null, url: `https://openalex.org/${id}`, pdfUrl: null, openAccess: false, topics,
});
const s2Id = (n: number) => `S2:${n.toString(16).padStart(40, '0')}`;
const s2Fixture = (n: number) => normalizeSemanticPaper({ paperId: s2Id(n).slice(3), title: `Semantic fixture ${n}`, references: [] });
const cachedDate = '2001-01-01T00:00:00.000Z';

async function temporary(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'openpapers-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function verifyGraph(graph: GraphResponse, papers: Paper[]) {
  const records = new Map(papers.map(p => [p.id, p]));
  const ids = new Set(graph.nodes.map(p => p.id));
  assert.equal(ids.size, graph.nodes.length);
  assert.ok(graph.nodes.length <= 40);
  for (const origin of graph.origins) assert.equal(graph.nodes.find(p => p.id === origin)?.isOrigin, true);
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    assert.ok(ids.has(edge.source) && ids.has(edge.target));
    assert.notEqual(edge.source, edge.target);
    const key = [edge.source, edge.target].sort().join(':');
    assert.ok(!seen.has(key));
    seen.add(key);
    const a = records.get(edge.source)!, b = records.get(edge.target)!;
    const ra = new Set(a.references), rb = new Set(b.references);
    const shared = [...ra].filter(id => rb.has(id)).length;
    const ca = papers.filter(p => p.references.includes(a.id));
    const cb = papers.filter(p => p.references.includes(b.id));
    const co = ca.filter(p => p.references.includes(b.id)).length;
    assert.equal(edge.sharedReferences, shared);
    assert.equal(edge.coCitations, co);
    assert.ok(shared + co > 0, 'Every edge must have real citation evidence');
    const expected = ((ra.size && rb.size ? shared / Math.sqrt(ra.size * rb.size) : 0) +
      (ca.length && cb.length ? co / Math.sqrt(ca.length * cb.length) : 0)) / 2;
    assert.ok(Math.abs(edge.weight - expected) < 1e-12);
    assert.ok(edge.weight > 0 && edge.weight <= 1);
  }
  for (const node of graph.nodes) {
    assert.ok(records.has(node.id));
    assert.equal(node.title, records.get(node.id)!.title);
    assert.equal(node.graphConnections, graph.edges.filter(e => e.source === node.id || e.target === node.id).length);
  }
  for (const prior of graph.prior) {
    assert.equal(prior.graphConnections, graph.nodes.filter(p => p.references.includes(prior.id)).length);
    assert.ok(prior.graphConnections >= 2);
  }
  for (const derivative of graph.derivative) {
    assert.equal(derivative.graphConnections, derivative.references.filter(id => ids.has(id)).length);
    assert.ok(derivative.graphConnections >= 2);
  }
}

test('coupling cosine is exact, symmetric and immune to duplicated reference IDs', () => {
  const papers = [fixture('W1', ['W10', 'W11', 'W10']), fixture('W2', ['W10', 'W12']), fixture('W3', ['W99'])];
  const graph = buildGraph(papers, ['W1'], meta);
  const edge = graph.edges.find(e => e.source === 'W1' && e.target === 'W2')!;
  assert.equal(edge.sharedReferences, 1);
  assert.equal(edge.coCitations, 0);
  assert.equal(edge.weight, 0.25);
  assert.ok(!graph.nodes.some(p => p.id === 'W3'));
  assert.equal(buildGraph(papers, ['W2'], meta).edges[0].weight, edge.weight);
});

test('co-citation works without outgoing references; direct citations do not invent similarity', () => {
  const papers = [fixture('W1'), fixture('W2'), fixture('W3', ['W1', 'W2']), fixture('W4', ['W1'])];
  const graph = buildGraph(papers, ['W1', 'W3'], meta);
  const edge = graph.edges.find(e => [e.source, e.target].includes('W1') && [e.source, e.target].includes('W2'))!;
  assert.equal(edge.sharedReferences, 0);
  assert.equal(edge.coCitations, 1);
  assert.ok(Math.abs(edge.weight - 1 / (2 * Math.sqrt(2))) < 1e-12);
  assert.ok(!graph.edges.some(e => [e.source, e.target].sort().join(',') === 'W1,W3'));
  verifyGraph(graph, papers);
});

test('identical topic labels and unrelated origins never produce fallback edges', () => {
  const graph = buildGraph([fixture('W1', ['W10'], ['Physics']), fixture('W2', ['W20'], ['Physics'])], ['W1', 'W2'], meta);
  assert.equal(graph.nodes.length, 2);
  assert.deepEqual(graph.edges, []);
  assert.match(graph.meta.warning!, /no artificial edges/);
  assert.throws(() => buildGraph([fixture('W1')], ['W2'], meta), /origin is missing/);
});

test('bundled snapshot is provider-sourced, bounded, DOI queried and hash checked, not scholarly truth verified', async () => {
  const manifest = JSON.parse(await readFile(fileURLToPath(new URL('../data/manifest.json', import.meta.url)), 'utf8'));
  assert.equal(createHash('sha256').update(snapshotText).digest('hex'), manifest.snapshotSha256);
  assert.ok(manifest.requestsMade <= 29);
  assert.equal(snapshot.groups.length, 3);
  assert.deepEqual(manifest.seedDois, ['10.48550/arXiv.1706.03762', '10.1126/science.1225829', '10.1103/PhysRevLett.116.061102']);
  assert.equal(snapshot.groups[0].papers.find(p => p.id === snapshot.groups[0].origin)!.title.toLowerCase(), 'attention is all you need');
  assert.equal(snapshot.groups[1].papers.find(p => p.id === snapshot.groups[1].origin)!.doi, 'https://doi.org/10.1126/science.1225829');
  assert.equal(snapshot.groups[2].papers.find(p => p.id === snapshot.groups[2].origin)!.doi, 'https://doi.org/10.1103/physrevlett.116.061102');
  for (const group of snapshot.groups) {
    assert.ok(group.papers.length >= 100 && group.papers.length <= 300);
    const origin = group.papers.find(p => p.id === group.origin)!;
    assert.ok(origin.references.length > 20);
    assert.ok(origin.authors.length > 0);
    assert.ok(group.papers.some(p => p.references.includes(group.origin)));
    assert.match(group.coverage, /not exhaustive/);
  }
});

test('all three actual offline example graphs have 35-45 nodes and verified edges/rankings', () => {
  for (const group of snapshot.groups) {
    const graph = buildGraph(group.papers, [group.origin], { ...meta, coverage: group.coverage });
    assert.ok(graph.nodes.length >= 35 && graph.nodes.length <= 45);
    assert.ok(graph.edges.length > 0);
    assert.ok(graph.prior.length > 0);
    assert.ok(graph.derivative.length > 0);
    verifyGraph(graph, group.papers);
    assert.deepEqual(buildGraph(group.papers, [group.origin], meta).nodes, graph.nodes);
  }
});

test('snapshot search matches title, CRISPR keyword, DOI and OpenAlex ID; pagination is real', () => {
  const searchMeta = { source: 'snapshot' as const, fetchedAt: snapshot.fetchedAt };
  assert.equal(localSearch(bundled, 'Attention Is All You Need', 1, searchMeta).results[0].id, snapshot.groups[0].origin);
  assert.equal(localSearch(bundled, '10.1126/science.1225829', 1, searchMeta).results[0].id, snapshot.groups[1].origin);
  assert.equal(localSearch(bundled, `https://openalex.org/${snapshot.groups[2].origin}`, 1, searchMeta).results[0].id, snapshot.groups[2].origin);
  assert.ok(localSearch(bundled, 'CRISPR', 1, searchMeta).results.some(p => /crispr/i.test([p.title, p.abstract, ...p.topics].join(' '))));
  const first = localSearch(bundled, 'neural', 1, searchMeta), second = localSearch(bundled, 'neural', 2, searchMeta);
  assert.ok(first.total > 20);
  assert.equal(first.total, second.total);
  assert.equal(first.results.length, 20);
  assert.equal(second.page, 2);
  assert.ok(second.results.every(p => !first.results.some(a => a.id === p.id)));
  assert.equal(localSearch(bundled, 'qzxvnonexistentliterature', 1, searchMeta).total, 0);
});

test('offline service rebuilds any selected node, supports three origins, persists graphs, and never fetches', async t => {
  const directory = await temporary(t);
  const cache = new PersistentCache(directory);
  let calls = 0;
  const provider = new OpenAlexProvider({ cache, fetch: async () => { calls++; throw new Error('Must not fetch'); } });
  const service = new PaperService(cache, true, provider);
  const graph = await service.graph([snapshot.groups[0].origin]);
  const selected = graph.nodes.find(p => !p.isOrigin)!;
  const rebuilt = await service.graph([selected.id]);
  assert.ok(rebuilt.nodes.find(p => p.id === selected.id)?.isOrigin);
  assert.equal(rebuilt.meta.source, 'snapshot');
  const origins = snapshot.groups.map(g => g.origin);
  const multi = await service.graph(origins);
  verifyGraph(multi, bundled);
  assert.ok(multi.nodes.length >= 35);
  assert.equal(multi.nodes.filter(p => p.isOrigin).length, 3);
  const restarted = new PaperService(new PersistentCache(directory), true, provider);
  const persisted = await restarted.graph(origins);
  assert.deepEqual(persisted.edges, multi.edges);
  assert.equal(persisted.meta.source, 'cache');
  assert.equal(persisted.meta.fetchedAt, multi.meta.fetchedAt);
  assert.match((await service.search('Attention Is All You Need', 1)).meta.warning!, /Offline/);
  assert.equal((await service.search('10.48550/arXiv.1706.03762', 1)).results[0].id, snapshot.groups[0].origin);
  await assert.rejects(service.graph(['W999999999999999']), error => error instanceof ApiError && error.status === 404);
  assert.equal(calls, 0);
});

test('live outage returns only local matches with a warning, not unrelated papers', async t => {
  const cache = new PersistentCache(await temporary(t));
  const provider = new OpenAlexProvider({ cache, fetch: async () => new Response('Unavailable', { status: 503 }) });
  const service = new PaperService(cache, false, provider);
  const result = await service.search('Attention Is All You Need', 1);
  assert.equal(result.results[0].id, snapshot.groups[0].origin);
  assert.equal(result.meta.source, 'snapshot');
  assert.match(result.meta.warning!, /OpenAlex unavailable/);
  assert.equal((await service.search('qzxvnonexistentliterature', 1)).results.length, 0);
  await assert.rejects(service.graph(['W999999999999999']), error => error instanceof ApiError && error.status === 503);
});

test('provider fixes origin, deduplicates, persists provenance, keeps keys out of cache and rejects unsafe paths', async t => {
  const directory = await temporary(t);
  const cache = new PersistentCache(directory);
  let calls = 0;
  const record: OpenAlexWork = { id: 'https://openalex.org/W1', display_name: 'Real provider fixture' };
  const provider = new OpenAlexProvider({ cache, apiKey: 'test-secret-not-for-cache', fetch: async (input, options) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.origin, OPENALEX_ORIGIN);
    assert.equal(options?.redirect, 'error');
    assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer test-secret-not-for-cache');
    return Response.json(record);
  } });
  const results = await Promise.all(Array.from({ length: 8 }, () => provider.getPaper('W1')));
  assert.equal(calls, 1);
  assert.equal(results[0].id, record.id);
  const timestamp = provider.metadata(results[0]).fetchedAt;
  const restarted = new OpenAlexProvider({ cache: new PersistentCache(directory), offline: true });
  const stored = await restarted.getPaper('W1');
  assert.equal(restarted.metadata(stored).source, 'cache');
  assert.equal(restarted.metadata(stored).fetchedAt, timestamp);
  const persisted = await readFile(`${directory}/openalex-cache-v1.json`, 'utf8');
  assert.ok(!persisted.includes('test-secret-not-for-cache'));
  for (const path of ['https://evil.example/works', '//evil.example/works', '/works/../../secret', '/rate-limit']) {
    await assert.rejects(provider.request(path), error => error instanceof ProviderError && error.status === 400);
  }
});

test('provider enforces two active requests, batch <=100, a hard budget and timeouts', async t => {
  const cache = new PersistentCache(await temporary(t));
  let active = 0, maximum = 0;
  const provider = new OpenAlexProvider({ cache, maxRequests: 4, fetch: async input => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 300));
    active--;
    return Response.json({ id: `https://openalex.org/${new URL(String(input)).pathname.split('/').pop()}` });
  } });
  await Promise.all(['W1', 'W2', 'W3', 'W4'].map(id => provider.getPaper(id)));
  assert.ok(maximum <= 2);
  await assert.rejects(provider.getPaper('W5'), error => error instanceof ProviderError && error.status === 503);
  const batchSizes: number[] = [];
  const batchProvider = new OpenAlexProvider({ cache, fetch: async input => {
    const url = new URL(String(input));
    const ids = url.searchParams.get('filter')!.replace('openalex_id:', '').split('|');
    batchSizes.push(ids.length);
    return Response.json({ results: ids.map(id => ({ id: `https://openalex.org/${id}` })), meta: { count: ids.length } });
  } });
  assert.equal((await batchProvider.batch(Array.from({ length: 205 }, (_, i) => `W${i + 100}`))).length, 205);
  assert.deepEqual(batchSizes, [100, 100, 5]);
  const slow = new OpenAlexProvider({ cache, timeoutMs: 20, fetch: async (_input, options) => {
    return new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Mock deadline exceeded')), 1000);
      options!.signal!.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
    });
  } });
  const started = Date.now();
  await assert.rejects(slow.getPaper('W99'), error => error instanceof ProviderError && error.status === 503);
  assert.ok(Date.now() - started < 1000);
});

test('normalization reconstructs actual abstracts and rejects executable external links', () => {
  const paper = normalizeWork({ id: 'https://openalex.org/W1', display_name: 'Actual metadata',
    abstract_inverted_index: { Actual: [0], abstract: [1] }, doi: 'javascript:alert(1)',
    primary_location: { landing_page_url: 'file:///etc/passwd', pdf_url: 'data:text/html,evil' },
    referenced_works: ['https://openalex.org/W2', 'https://evil.test/W3', 'https://openalex.org/W2', 'https://openalex.org/W1'],
  });
  assert.equal(paper.abstract, 'Actual abstract');
  assert.deepEqual(paper.references, ['W2']);
  assert.equal(paper.doi, null);
  assert.equal(paper.pdfUrl, null);
  assert.equal(paper.url, 'https://openalex.org/W1');
});

test('persistent cache is bounded, handles corruption and deduplicates errors without poisoning retries', async t => {
  const directory = await temporary(t);
  const cache = new PersistentCache(directory, 2, 2048);
  await cache.set('a', { value: 'a' }, -1);
  assert.equal(await cache.get('a'), undefined);
  assert.ok(await cache.get('a', true));
  await cache.set('b', { value: 'b' });
  await cache.set('c', { value: 'c' });
  assert.equal(await cache.get('a', true), undefined);
  assert.ok((await readFile(`${directory}/openalex-cache-v1.json`)).byteLength <= 2048);
  let calls = 0;
  const operation = () => cache.deduplicate('failure', async () => { calls++; await Promise.resolve(); throw new Error('Expected'); });
  await Promise.allSettled([operation(), operation()]);
  assert.equal(calls, 1);
  assert.equal(await cache.deduplicate('failure', async () => 42), 42);
  await writeFile(`${directory}/openalex-cache-v1.json`, '{broken');
  assert.equal(await new PersistentCache(directory).get('b'), undefined);
});

async function listen(app: ReturnType<typeof createApp>['app']): Promise<{ server: Server; origin: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

test('Express offline API contracts, bounded inputs, 404s, Helmet, rate limits and SPA fallback', async t => {
  const directory = await temporary(t);
  await writeFile(`${directory}/index.html`, '<!doctype html><title>SPA fixture</title>');
  const service = new PaperService(new PersistentCache(directory), true);
  const semanticService = new SemanticService(new PersistentCache(directory), true);
  await Promise.all([service.ready, semanticService.ready]);
  const { app } = createApp({ service, semanticService, defaultProvider: 'openalex', offline: true, rateLimit: 100, distPath: directory });
  const { server, origin } = await listen(app);
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const health = await fetch(`${origin}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).offline, true);
  assert.equal(health.headers.get('x-powered-by'), null);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(health.headers.get('content-security-policy')?.includes("object-src 'none'"));
  const examples = await (await fetch(`${origin}/api/examples`)).json();
  assert.ok(Array.isArray(examples));
  assert.equal(examples.length, 3);
  const search = await (await fetch(`${origin}/api/search?q=Attention%20Is%20All%20You%20Need&page=1`)).json() as SearchResponse;
  assert.equal(search.results[0].id, snapshot.groups[0].origin);
  const graph = await (await fetch(`${origin}/api/graph?ids=${examples[0].id}`)).json() as GraphResponse;
  assert.equal(graph.nodes.length, 40);
  const paper = await (await fetch(`${origin}/api/paper/${examples[0].id}`)).json();
  assert.equal(paper.paper.id, examples[0].id);
  const invalid = [
    '/api/search', '/api/search?q=', '/api/search?q=a&q=b', '/api/search?q[x]=a',
    '/api/search?q=a&page=0', '/api/search?q=a&page=1.5', '/api/search?q=a&page=101', '/api/search?q=a&page=1&page=2',
    `/api/search?q=${'a'.repeat(201)}`, '/api/search?q=%00',
    '/api/graph', '/api/graph?ids=W1,W1', '/api/graph?ids=W1,W2,W3,W4', '/api/graph?ids=https://evil.test/x',
    '/api/graph?ids=W1&ids=W2', '/api/graph?ids=W0', '/api/paper/invalid', '/api/paper/%E0%A4%A',
  ];
  for (const path of invalid) assert.equal((await fetch(`${origin}${path}`)).status, 400, path);
  const unknown = await fetch(`${origin}/api/graph?ids=W999999999999999`);
  assert.equal(unknown.status, 404);
  assert.match((await unknown.json()).error, /offline collection/);
  assert.equal((await fetch(`${origin}/api/paper/W999999999999999`)).status, 404);
  assert.equal((await fetch(`${origin}/api/not-a-route`, { headers: { Accept: 'text/html' } })).status, 404);
  assert.equal((await fetch(`${origin}/api/search?q=${'a'.repeat(2100)}`)).status, 414);
  const spa = await fetch(`${origin}/graph/${examples[0].id}`, { headers: { Accept: 'text/html' } });
  assert.equal(spa.status, 200);
  assert.match(await spa.text(), /SPA fixture/);
  const limited = await listen(createApp({ service, semanticService, defaultProvider: 'openalex', offline: true, rateLimit: 1 }).app);
  t.after(() => new Promise<void>(resolve => limited.server.close(() => resolve())));
  assert.equal((await fetch(`${limited.origin}/api/health`)).status, 200);
  const rateLimited = await fetch(`${limited.origin}/api/examples`, { headers: { 'X-Forwarded-For': '192.0.2.99' } });
  assert.equal(rateLimited.status, 429);
  assert.ok(rateLimited.headers.get('retry-after'));
});

test('API response deadline is bounded and late completions cannot write a second response', async t => {
  const cache = new PersistentCache(await temporary(t));
  const service = new PaperService(cache, true);
  const semanticService = new SemanticService(cache, true);
  await Promise.all([service.ready, semanticService.ready]);
  service.search = async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    return { results: [], total: 0, page: 1, perPage: 20, meta: { source: 'snapshot', fetchedAt: snapshot.fetchedAt } };
  };
  const { server, origin } = await listen(createApp({ service, semanticService, defaultProvider: 'openalex', requestTimeoutMs: 10 }).app);
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const response = await fetch(`${origin}/api/search?q=anything`);
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: 'Request timed out; try again shortly' });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal((await fetch(`${origin}/api/health`)).status, 200);
});

test('Express live unknown ID is 404; upstream failures and internal errors do not leak details', async t => {
  const cache = new PersistentCache(await temporary(t));
  const provider = new OpenAlexProvider({ cache, fetch: async () => new Response('Private upstream response', { status: 404 }) });
  const service = new PaperService(cache, false, provider);
  const semanticService = new SemanticService(cache, true);
  await Promise.all([service.ready, semanticService.ready]);
  const { server, origin } = await listen(createApp({ service, semanticService, defaultProvider: 'openalex' }).app);
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const unknown = await fetch(`${origin}/api/graph?ids=W999999999999999`);
  assert.equal(unknown.status, 404);
  assert.ok(!(await unknown.text()).includes('Private upstream response'));
  service.graph = async () => { throw new Error('secret-path-and-api-key'); };
  const failed = await fetch(`${origin}/api/graph?ids=${snapshot.groups[0].origin}`);
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: 'Request could not be completed' });
});

test('provider discovery validates DEFAULT_PROVIDER, redacts keys and keeps OpenAlex examples under either default', async t => {
  const saved = { DEFAULT_PROVIDER: process.env.DEFAULT_PROVIDER, OPENALEX_API_KEY: process.env.OPENALEX_API_KEY, S2_API_KEY: process.env.S2_API_KEY };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.OPENALEX_API_KEY = 'private-openalex-discovery-key';
  process.env.S2_API_KEY = 'private-s2-discovery-key';
  const cache = new PersistentCache(await temporary(t));
  await cache.set('search:1:providerfixture', { results: [fixture('W900001')], total: 1, page: 1, perPage: 20,
    meta: { source: 'live', fetchedAt: cachedDate } });
  await cache.set('s2:search:v1:1:providerfixture', { results: [s2Fixture(1)], total: 1, page: 1, perPage: 20,
    meta: { source: 'live', provider: 'semantic-scholar', fetchedAt: cachedDate } });
  let calls = 0;
  const service = new PaperService(cache, true, new OpenAlexProvider({ cache, fetch: async () => { calls++; throw new Error('Unexpected traffic'); } }));
  const semanticService = new SemanticService(cache, true, new SemanticScholarProvider({ cache, fetch: async () => { calls++; throw new Error('Unexpected traffic'); } }));
  await Promise.all([service.ready, semanticService.ready]);
  for (const invalid of ['', 'unknown', 'Semantic-Scholar', 'openalex,semantic-scholar']) {
    process.env.DEFAULT_PROVIDER = invalid;
    assert.throws(() => createApp({ service, semanticService }), /DEFAULT_PROVIDER must be openalex or semantic-scholar/);
  }
  assert.doesNotThrow(() => createApp({ service, semanticService, defaultProvider: 'openalex' }));
  for (const selected of ['openalex', 'semantic-scholar'] as const) {
    process.env.DEFAULT_PROVIDER = selected;
    const { server, origin } = await listen(createApp({ service, semanticService, offline: true, rateLimit: 100 }).app);
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const discovery = await fetch(`${origin}/api/providers`);
    assert.equal(discovery.status, 200);
    const discoveryText = await discovery.text();
    assert.ok(!discoveryText.includes(process.env.OPENALEX_API_KEY!));
    assert.ok(!discoveryText.includes(process.env.S2_API_KEY!));
    assert.deepEqual(JSON.parse(discoveryText), { defaultProvider: selected, providers: [
      { id: 'openalex', name: 'OpenAlex', keyConfigured: true, offline: true },
      { id: 'semantic-scholar', name: 'Semantic Scholar', keyConfigured: true, offline: true },
    ] });
    const health = await fetch(`${origin}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok', provider: selected === 'openalex' ? 'OpenAlex' : 'Semantic Scholar', offline: true });
    const defaults = await (await fetch(`${origin}/api/search?q=providerfixture`)).json() as SearchResponse;
    assert.equal(defaults.meta.provider, selected);
    assert.equal(defaults.results[0].id, selected === 'openalex' ? 'W900001' : s2Id(1));
    for (const provider of ['openalex', 'semantic-scholar']) {
      const response = await fetch(`${origin}/api/search?q=providerfixture&provider=${provider}`);
      assert.equal(response.status, 200);
      const result = await response.json() as SearchResponse;
      assert.equal(result.meta.provider, provider);
      assert.equal(result.meta.source, 'cache');
      assert.equal(result.meta.fetchedAt, cachedDate);
      assert.equal(result.results[0].id, provider === 'openalex' ? 'W900001' : s2Id(1));
    }
    const examples = await (await fetch(`${origin}/api/examples`)).json();
    assert.deepEqual(examples, (await service.examples()).map(example => ({ ...example, provider: 'openalex' })));
    assert.deepEqual(examples.map((example: { id: string }) => example.id), snapshot.examples.map(example => example.id));
    const oaPaper = await (await fetch(`${origin}/api/paper/${examples[0].id}`)).json();
    assert.equal(oaPaper.meta.provider, 'openalex');
    assert.equal(oaPaper.meta.source, 'snapshot');
    assert.equal(oaPaper.paper.id, examples[0].id);
    const oaGraph = await (await fetch(`${origin}/api/graph?ids=${examples[0].id}`)).json() as GraphResponse;
    assert.equal(oaGraph.meta.provider, 'openalex');
    assert.ok(oaGraph.nodes.every(paper => /^W\d+$/.test(paper.id)));
  }
  delete process.env.DEFAULT_PROVIDER;
  delete process.env.OPENALEX_API_KEY;
  delete process.env.S2_API_KEY;
  const { server, origin } = await listen(createApp({ service, semanticService }).app);
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const unconfigured = await (await fetch(`${origin}/api/providers`)).json();
  assert.equal(unconfigured.defaultProvider, 'openalex');
  assert.equal(unconfigured.providers.length, 1);
  assert.equal(unconfigured.providers[0].id, 'openalex');
  assert.equal(unconfigured.providers[0].keyConfigured, false);
  assert.equal(calls, 0);
});

test('without an S2 key, a Semantic Scholar default falls back to OpenAlex and blocks even cached S2 search without affecting saved papers/graphs', async t => {
  const saved = { DEFAULT_PROVIDER: process.env.DEFAULT_PROVIDER, OPENALEX_API_KEY: process.env.OPENALEX_API_KEY, S2_API_KEY: process.env.S2_API_KEY };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.DEFAULT_PROVIDER = 'semantic-scholar';
  delete process.env.OPENALEX_API_KEY;
  delete process.env.S2_API_KEY;
  const cache = new PersistentCache(await temporary(t));
  await cache.set('search:1:providerfixture', { results: [fixture('W900001')], total: 1, page: 1, perPage: 20,
    meta: { source: 'live', fetchedAt: cachedDate } });
  await cache.set('s2:search:v1:1:providerfixture', { results: [s2Fixture(1)], total: 1, page: 1, perPage: 20,
    meta: { source: 'live', provider: 'semantic-scholar', fetchedAt: cachedDate } });
  await cache.set(`s2:pool:v1:${s2Id(1)}`, { origin: s2Id(1), papers: [s2Fixture(1)], provider: 'semantic-scholar',
    source: 'live', fetchedAt: cachedDate, coverage: 'Saved Semantic Scholar fixture' });
  await cache.set('pool:W900001', { origin: 'W900001', papers: [fixture('W900001')], source: 'live',
    fetchedAt: cachedDate, coverage: 'Saved OpenAlex fixture' });
  let calls = 0;
  const noFetch = async () => { calls++; throw new Error('Unexpected upstream traffic'); };
  const service = new PaperService(cache, false, new OpenAlexProvider({ cache, fetch: noFetch }));
  const semanticService = new SemanticService(cache, false, new SemanticScholarProvider({ cache, fetch: noFetch }));
  await Promise.all([service.ready, semanticService.ready]);
  const cached = await semanticService.search('providerfixture', 1);
  assert.equal(cached.meta.source, 'cache');
  assert.equal(cached.results[0].id, s2Id(1));
  for (const defaultProvider of [undefined, 'semantic-scholar'] as const) {
    const { server, origin } = await listen(createApp({ service, semanticService, defaultProvider, offline: false }).app);
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const discovery = await fetch(`${origin}/api/providers`);
    assert.equal(discovery.status, 200);
    assert.deepEqual(await discovery.json(), { defaultProvider: 'openalex', providers: [
      { id: 'openalex', name: 'OpenAlex', keyConfigured: false, offline: false },
    ] });
    const health = await fetch(`${origin}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok', provider: 'OpenAlex', offline: false });
    for (const suffix of ['', '&provider=openalex']) {
      const response = await fetch(`${origin}/api/search?q=providerfixture${suffix}`);
      assert.equal(response.status, 200);
      const result = await response.json() as SearchResponse;
      assert.equal(result.meta.provider, 'openalex');
      assert.equal(result.meta.source, 'cache');
      assert.equal(result.meta.fetchedAt, cachedDate);
      assert.equal(result.results[0].id, 'W900001');
    }
    for (const query of ['providerfixture', 'uncachedfixture']) {
      const response = await fetch(`${origin}/api/search?q=${query}&provider=semantic-scholar`);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'Semantic Scholar search is disabled until S2_API_KEY is configured. Use OpenAlex instead.' });
    }
    for (const id of ['W900001', s2Id(1)]) {
      const provider = id.startsWith('S2:') ? 'semantic-scholar' : 'openalex';
      for (const suffix of ['', `&provider=${provider}`]) {
        const response = await fetch(`${origin}/api/graph?ids=${id}${suffix}`);
        assert.equal(response.status, 200);
        const graph = await response.json() as GraphResponse;
        assert.deepEqual(graph.origins, [id]);
        assert.equal(graph.meta.provider, provider);
        assert.ok(graph.nodes.some(paper => paper.id === id && paper.isOrigin));
        if (provider === 'semantic-scholar') {
          assert.equal(graph.meta.source, 'cache');
          assert.equal(graph.meta.fetchedAt, cachedDate);
        }
      }
      for (const suffix of ['', `?provider=${provider}`]) {
        const response = await fetch(`${origin}/api/paper/${id}${suffix}`);
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.paper.id, id);
        assert.equal(result.meta.provider, provider);
        if (provider === 'semantic-scholar') {
          assert.equal(result.meta.source, 'cache');
          assert.equal(result.meta.fetchedAt, cachedDate);
        }
      }
    }
  }
  assert.equal(calls, 0, 'Disabled S2 search and saved graph/paper access must not fetch upstream');
});

test('API infers graph/paper providers, accepts three full S2 IDs and rejects invalid selectors before fetch', async t => {
  const savedKey = process.env.S2_API_KEY;
  t.after(() => {
    if (savedKey === undefined) delete process.env.S2_API_KEY; else process.env.S2_API_KEY = savedKey;
  });
  process.env.S2_API_KEY = 'mock-s2-validation-key';
  const cache = new PersistentCache(await temporary(t));
  for (let n = 1; n <= 3; n++) {
    await cache.set(`s2:pool:v1:${s2Id(n)}`, { origin: s2Id(n), papers: [s2Fixture(n)], provider: 'semantic-scholar',
      source: 'live', fetchedAt: cachedDate, coverage: 'Exact Semantic Scholar fixture' });
  }
  await cache.set('pool:W900001', { origin: 'W900001', papers: [fixture('W900001')], source: 'live', fetchedAt: cachedDate, coverage: 'Exact OpenAlex fixture' });
  let calls = 0;
  const noFetch = async () => { calls++; return new Response('Unexpected private upstream traffic', { status: 503 }); };
  const service = new PaperService(cache, false, new OpenAlexProvider({ cache, fetch: noFetch }));
  const semanticService = new SemanticService(cache, false, new SemanticScholarProvider({ cache, fetch: noFetch }));
  await Promise.all([service.ready, semanticService.ready]);
  const { app } = createApp({ service, semanticService, defaultProvider: 'openalex', rateLimit: 100 });
  const { server, origin } = await listen(app);
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const ids = [s2Id(1), s2Id(2), s2Id(3)];
  assert.equal(ids.join(',').length, 131, 'Three canonical S2 IDs require the full graph query bound');
  for (const suffix of ['', '&provider=semantic-scholar']) {
    const response = await fetch(`${origin}/api/graph?ids=${ids.join(',')}${suffix}`);
    assert.equal(response.status, 200);
    const graph = await response.json() as GraphResponse;
    assert.deepEqual(graph.origins, ids);
    assert.equal(graph.nodes.filter(paper => paper.isOrigin).length, 3);
    assert.equal(graph.meta.provider, 'semantic-scholar');
    assert.equal(graph.meta.source, 'cache');
    assert.equal(graph.meta.fetchedAt, cachedDate);
  }
  for (const id of [s2Id(1), 'W900001']) {
    const response = await fetch(`${origin}/api/paper/${id}`);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.paper.id, id);
    assert.equal(result.meta.provider, id.startsWith('S2:') ? 'semantic-scholar' : 'openalex');
    assert.equal(result.meta.source, 'cache');
    assert.equal(result.meta.fetchedAt, cachedDate);
  }
  const oaGraph = await fetch(`${origin}/api/graph?ids=W900001&provider=openalex`);
  assert.equal(oaGraph.status, 200);
  assert.equal((await oaGraph.json()).meta.provider, 'openalex');
  const invalid = [
    `/api/graph?ids=${s2Id(90)},W900090`, `/api/graph?ids=${s2Id(90)}&provider=openalex`,
    '/api/graph?ids=W900090&provider=semantic-scholar', `/api/paper/${s2Id(90)}?provider=openalex`,
    '/api/paper/W900090?provider=semantic-scholar', `/api/graph?ids=${ids.join(',')},${s2Id(4)}`,
    `/api/graph?ids=${s2Id(1)},${s2Id(1)}`, `/api/graph?ids=S2:${'a'.repeat(39)}`,
    `/api/paper/S2:${'a'.repeat(41)}`,
  ];
  for (const base of ['/api/search?q=uncachedfixture', `/api/graph?ids=${s2Id(90)}`, `/api/paper/${s2Id(90)}`]) {
    for (const selector of ['provider=unknown', 'provider=', 'provider=%00', `provider=${'a'.repeat(21)}`,
      'provider=openalex&provider=semantic-scholar', 'provider=semantic-scholar&provider=semantic-scholar']) {
      invalid.push(`${base}${base.includes('?') ? '&' : '?'}${selector}`);
    }
  }
  invalid.push('/api/search?q=uncachedfixture&page=51&provider=semantic-scholar');
  for (const path of invalid) assert.equal((await fetch(`${origin}${path}`)).status, 400, path);
  // Exercise object-valued selectors as well as the arrays produced by repeated keys.
  app.set('query parser', 'extended');
  for (const base of ['/api/search?q=uncachedfixture', `/api/graph?ids=${s2Id(90)}`, `/api/paper/${s2Id(90)}`]) {
    const path = `${base}${base.includes('?') ? '&' : '?'}provider[x]=semantic-scholar`;
    assert.equal((await fetch(`${origin}${path}`)).status, 400, path);
  }
  assert.equal(calls, 0, 'Provider validation must complete before upstream acquisition');
});

test('S2 API live and empty cached search/paper responses retain source, provider, dates and server-only keys', async t => {
  const savedKey = process.env.S2_API_KEY;
  t.after(() => {
    if (savedKey === undefined) delete process.env.S2_API_KEY; else process.env.S2_API_KEY = savedKey;
  });
  const directory = await temporary(t);
  const store = new PersistentCache(directory);
  const secret = 'private-s2-api-response-key';
  process.env.S2_API_KEY = secret;
  let calls = 0;
  const provider = new SemanticScholarProvider({ cache: store, apiKey: secret, fetch: async (input, options) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.origin, S2_ORIGIN);
    assert.equal((options?.headers as Record<string, string>)['x-api-key'], secret);
    assert.ok(!url.href.includes(secret));
    if (url.pathname.endsWith('/search')) return Response.json({ offset: 0, total: 0, data: [] });
    return Response.json({ paperId: s2Id(1).slice(3), title: 'Semantic live API fixture', references: [] });
  } });
  const service = new PaperService(store, true);
  const semanticService = new SemanticService(store, false, provider);
  await Promise.all([service.ready, semanticService.ready]);
  const { server, origin } = await listen(createApp({ service, semanticService, defaultProvider: 'semantic-scholar' }).app);
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const paperResponse = await fetch(`${origin}/api/paper/${s2Id(1)}`);
  assert.equal(paperResponse.status, 200);
  const live = await paperResponse.json();
  assert.equal(live.meta.source, 'live');
  assert.equal(live.meta.provider, 'semantic-scholar');
  const reused = await (await fetch(`${origin}/api/paper/${s2Id(1)}`)).json();
  assert.equal(reused.meta.source, 'cache');
  assert.equal(reused.meta.fetchedAt, live.meta.fetchedAt);
  const response = await fetch(`${origin}/api/search?q=emptyfixture`);
  assert.equal(response.status, 200);
  const empty = await response.json() as SearchResponse;
  assert.deepEqual(empty.results, []);
  assert.equal(empty.total, 0);
  assert.equal(empty.meta.provider, 'semantic-scholar');
  assert.equal(empty.meta.source, 'live');
  const cached = await (await fetch(`${origin}/api/search?q=emptyfixture`)).json() as SearchResponse;
  assert.deepEqual(cached.results, []);
  assert.equal(cached.total, 0);
  assert.equal(cached.meta.provider, 'semantic-scholar');
  assert.equal(cached.meta.source, 'cache');
  assert.equal(cached.meta.fetchedAt, empty.meta.fetchedAt);
  assert.equal(calls, 2);
  assert.ok(!JSON.stringify([live, reused, empty, cached]).includes(secret));
  assert.ok(!(await readFile(`${directory}/openalex-cache-v1.json`, 'utf8')).includes(secret));
});

test('uncached S2 API outages/offline failures are actionable 503s without relabeled OpenAlex matches or key leaks', async t => {
  const savedKey = process.env.S2_API_KEY;
  t.after(() => {
    if (savedKey === undefined) delete process.env.S2_API_KEY; else process.env.S2_API_KEY = savedKey;
  });
  const secret = 'private-unavailable-s2-key';
  process.env.S2_API_KEY = secret;
  for (const offline of [false, true]) {
    const cache = new PersistentCache(await temporary(t));
    let calls = 0;
    const provider = new SemanticScholarProvider({ cache, apiKey: secret, fetch: async () => {
      calls++; return new Response(`${secret} private upstream response`, { status: 503 });
    } });
    const service = new PaperService(cache, true);
    const semanticService = new SemanticService(cache, offline, provider);
    await Promise.all([service.ready, semanticService.ready]);
    const { server, origin } = await listen(createApp({ service, semanticService, defaultProvider: 'semantic-scholar', offline }).app);
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    for (const path of ['/api/search?q=Attention%20Is%20All%20You%20Need', `/api/paper/${s2Id(90)}`, `/api/graph?ids=${s2Id(90)}`]) {
      const response = await fetch(`${origin}${path}`);
      assert.equal(response.status, 503, path);
      const text = await response.text();
      assert.match(text, /no matching Semantic Scholar cache/);
      assert.match(text, /S2_API_KEY/);
      assert.match(text, /No OpenAlex data is returned as Semantic Scholar/);
      assert.ok(!text.includes(secret));
      assert.ok(!text.includes('private upstream response'));
      assert.deepEqual(Object.keys(JSON.parse(text)), ['error']);
    }
    const oa = await fetch(`${origin}/api/search?q=Attention%20Is%20All%20You%20Need&provider=openalex`);
    assert.equal(oa.status, 200);
    const matches = await oa.json() as SearchResponse;
    assert.equal(matches.results[0].id, snapshot.groups[0].origin);
    assert.equal(matches.meta.provider, 'openalex');
    assert.equal(calls, offline ? 0 : 3);
  }
});
