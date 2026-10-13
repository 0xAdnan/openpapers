import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PersistentCache } from './cache.ts';
import { collectCandidates, type CandidatePool } from './collection.ts';
import { createApp } from './index.ts';
import { buildGraph, ALGORITHM } from './graph.ts';
import { OpenAlexProvider, SELECT, normalizeWork, type OpenAlexWork, type WorksPage } from './openalex.ts';
import { PaperService } from './service.ts';
import { SemanticService } from './semantic-service.ts';

const snapshot = JSON.parse(await readFile(new URL('../data/snapshot.json', import.meta.url), 'utf8')) as { groups: CandidatePool[] };
const oldTime = '2001-01-01T00:00:00.000Z';
const work = (id: string): OpenAlexWork => ({ id: `https://openalex.org/${id}`, display_name: `Paper ${id}` });
const pool = (id: string): CandidatePool => ({ origin: id, papers: [normalizeWork(work(id))], source: 'live', fetchedAt: oldTime, coverage: 'Old exact-origin neighborhood.' });

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'openpapers-review-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, cache: new PersistentCache(directory) };
}

async function listen(t: TestContext, service: PaperService, requestTimeoutMs = 30) {
  const semanticService = new SemanticService(service.cache, true);
  await Promise.all([service.ready, semanticService.ready]);
  const server = createApp({ service, semanticService, defaultProvider: 'openalex', rateLimit: 1000, requestTimeoutMs }).app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

test('504s retain all 16 API slots until the actual service operations settle', async t => {
  const { cache } = await setup(t);
  const service = new PaperService(cache, true);
  let active = 0, maximum = 0;
  let finish!: () => void;
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  t.after(finish);
  service.search = async () => {
    active++; maximum = Math.max(maximum, active);
    await blocked;
    active--;
    return { results: [], total: 0, page: 1, perPage: 20, meta: { source: 'cache', fetchedAt: oldTime } };
  };
  const origin = await listen(t, service);
  const first = await Promise.all(Array.from({ length: 16 }, (_, i) => fetch(`${origin}/api/search?q=blocked${i}`)));
  assert.ok(first.every(response => response.status === 504));
  assert.equal(active, 16);
  const repeated = await Promise.all(Array.from({ length: 16 }, (_, i) => fetch(`${origin}/api/search?q=repeated${i}`)));
  assert.ok(repeated.every(response => response.status === 503));
  assert.equal(maximum, 16);
  finish();
  await delay(10);
  assert.equal((await fetch(`${origin}/api/health`)).status, 200);
});

test('a service deadline cancels real fetch and stops further graph acquisition', async t => {
  const { cache } = await setup(t);
  let calls = 0, active = 0, aborted = 0;
  const provider = new OpenAlexProvider({ cache, fetch: async (_url, options) => {
    calls++; active++;
    try { await delay(10000, undefined, { signal: options!.signal! }); }
    catch (error) { aborted++; throw error; }
    finally { active--; }
    return Response.json(work('W1'));
  } });
  const service = new PaperService(cache, false, provider);
  await service.ready;
  const origin = await listen(t, service, 50);
  assert.equal((await fetch(`${origin}/api/graph?ids=W1`)).status, 504);
  await delay(20);
  assert.equal(active, 0);
  assert.equal(aborted, 1);
  assert.equal(calls, 1);
  assert.equal(await cache.get('pool:W1', true), undefined);
});

test('client disconnect cancels real service work without releasing its slot before settlement', async t => {
  const { cache } = await setup(t);
  let active = 0;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const provider = new OpenAlexProvider({ cache, fetch: async (_input, options) => {
    active++; started();
    try { await delay(10000, undefined, { signal: options!.signal! }); }
    finally { active--; }
    return Response.json(work('W1'));
  } });
  const service = new PaperService(cache, false, provider);
  await service.ready;
  const origin = await listen(t, service, 1000);
  const client = new AbortController();
  const request = assert.rejects(fetch(`${origin}/api/paper/W1`, { signal: client.signal }));
  await entered;
  client.abort();
  await request;
  await delay(20);
  assert.equal(active, 0);
  assert.equal((await fetch(`${origin}/api/health`)).status, 200);
});

test('provider deadlines include queue and pacing, and cancelled waiters never fetch', async t => {
  const { cache } = await setup(t);
  const fetched: string[] = [];
  const provider = new OpenAlexProvider({ cache, timeoutMs: 60, fetch: async (input, options) => {
    fetched.push(new URL(String(input)).pathname);
    await delay(10000, undefined, { signal: options!.signal! });
    return Response.json(work('W1'));
  } });
  const start = Date.now();
  await Promise.allSettled(['W1', 'W2', 'W3', 'W4'].map(id => provider.getPaper(id)));
  assert.ok(Date.now() - start < 250, 'queue/pacing must share the absolute provider deadline');
  assert.deepEqual(fetched, ['/works/W1']);
});

test('deduplicated service work survives one cancelled consumer but aborts when all detach', async t => {
  const { cache } = await setup(t);
  let calls = 0, aborted = 0;
  let started!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const provider = new OpenAlexProvider({ cache, fetch: async (_input, options) => {
    calls++; started();
    await new Promise<void>((resolve, reject) => {
      const cancel = () => { aborted++; reject(options!.signal!.reason); };
      options!.signal!.addEventListener('abort', cancel, { once: true });
      void blocked.then(() => { options!.signal!.removeEventListener('abort', cancel); resolve(); });
    });
    return Response.json({ results: [work('W1')], meta: { count: 1 } });
  } });
  const service = new PaperService(cache, false, provider);
  await service.ready;
  const cancelled = new AbortController(), survivor = new AbortController();
  const first = service.search('shared', 1, cancelled.signal);
  const second = service.search('shared', 1, survivor.signal);
  const firstRejected = assert.rejects(first, /cancelled consumer/);
  await entered;
  cancelled.abort(new Error('cancelled consumer'));
  await delay(10);
  assert.equal(aborted, 0);
  assert.equal(calls, 1);
  finish();
  await firstRejected;
  assert.equal((await second).results[0].id, 'W1');

  const allCache = new PersistentCache((await setup(t)).directory);
  let actualActive = 0;
  const allProvider = new OpenAlexProvider({ cache: allCache, fetch: async (_input, options) => {
    actualActive++;
    try { await delay(10000, undefined, { signal: options!.signal! }); }
    finally { actualActive--; }
    return Response.json({ results: [], meta: { count: 0 } });
  } });
  const allService = new PaperService(allCache, false, allProvider);
  await allService.ready;
  const a = new AbortController(), b = new AbortController();
  const operations = Promise.allSettled([allService.search('all cancelled', 1, a.signal), allService.search('all cancelled', 1, b.signal)]);
  await delay(10);
  assert.equal(actualActive, 1);
  a.abort(); b.abort();
  assert.ok((await operations).every(result => result.status === 'rejected'));
  assert.equal(actualActive, 0);
  assert.equal(await allCache.get('search:1:all cancelled', true), undefined);
});

test('a whole graph deadline stops acquisition even when each individual provider call would be fast enough', async t => {
  const { cache } = await setup(t);
  let calls = 0;
  const provider = new OpenAlexProvider({ cache, timeoutMs: 1000, fetch: async input => {
    calls++;
    const url = new URL(String(input));
    return Response.json(url.pathname === '/works' ? { results: [], meta: { count: 0 } } : { ...work('W1'), referenced_works: ['https://openalex.org/W2'] });
  } });
  const service = new PaperService(cache, false, provider);
  await service.ready;
  await assert.rejects(service.graph(['W1'], AbortSignal.timeout(80)));
  assert.equal(calls, 1, 'pacing for the next fetch must be interrupted by the service deadline');
  await delay(300);
  assert.equal(calls, 1);
  assert.equal(await cache.get('pool:W1', true), undefined);
});

test('live reorigin fetches its own neighborhood instead of borrowing Attention candidates', async t => {
  const { cache } = await setup(t);
  const bert = snapshot.groups[0].papers.find(p => /bert:/i.test(p.title))!;
  assert.ok(bert);
  const calls: URL[] = [];
  const provider = new OpenAlexProvider({ cache, fetch: async input => {
    const url = new URL(String(input)); calls.push(url);
    return Response.json(url.pathname === '/works' ? { results: [], meta: { count: 0 } } : work(bert.id));
  } });
  const graph = await new PaperService(cache, false, provider).graph([bert.id]);
  assert.ok(calls.some(url => url.pathname === `/works/${bert.id}`));
  assert.ok(calls.some(url => url.searchParams.get('filter') === `cites:${bert.id}`));
  assert.equal(graph.meta.source, 'live');
  assert.equal(graph.meta.candidateCount, 1);
});

test('fresh legacy wrong-origin graph cache cannot suppress live reorigin acquisition', async t => {
  const { cache } = await setup(t);
  const selected = snapshot.groups[0].papers.find(p => p.id !== snapshot.groups[0].origin)!;
  const legacy = buildGraph(snapshot.groups[0].papers, [selected.id], { source: 'snapshot', fetchedAt: oldTime,
    candidateCount: snapshot.groups[0].papers.length, algorithm: ALGORITHM, coverage: 'Legacy borrowed neighborhood' });
  await cache.set(`graph:v1:${selected.id}`, legacy);
  let calls = 0;
  const provider = new OpenAlexProvider({ cache, fetch: async input => {
    calls++;
    return Response.json(new URL(String(input)).pathname === '/works' ? { results: [], meta: { count: 0 } } : work(selected.id));
  } });
  const graph = await new PaperService(cache, false, provider).graph([selected.id]);
  assert.equal(calls, 2);
  assert.equal(graph.meta.candidateCount, 1);
  assert.equal(graph.meta.source, 'live');
});

test('expired hydrated pools and papers refresh online and retain old dates only for warned outage fallback', async t => {
  const { directory, cache } = await setup(t);
  await cache.set('pool:W1', pool('W1'), -1);
  await cache.set('paper:W2', { paper: normalizeWork(work('W2')), meta: { source: 'live', fetchedAt: oldTime } }, -1);
  const calls: string[] = [];
  const restartedCache = new PersistentCache(directory);
  const provider = new OpenAlexProvider({ cache: restartedCache, fetch: async input => {
    const url = new URL(String(input)); calls.push(url.pathname);
    return Response.json(url.pathname === '/works' ? { results: [], meta: { count: 0 } } : work(url.pathname.split('/').pop()!));
  } });
  const service = new PaperService(restartedCache, false, provider);
  const graph = await service.graph(['W1']);
  assert.ok(calls.includes('/works/W1'));
  assert.notEqual(graph.meta.fetchedAt, oldTime);
  assert.equal(graph.meta.source, 'live');
  const paper = await service.paper('W2');
  assert.ok(calls.includes('/works/W2'));
  assert.notEqual(paper.meta.fetchedAt, oldTime);

  await restartedCache.set('pool:W3', pool('W3'), -1);
  await restartedCache.set('paper:W4', { paper: normalizeWork(work('W4')), meta: { source: 'live', fetchedAt: oldTime } }, -1);
  const outageCache = new PersistentCache(directory);
  const outage = new PaperService(outageCache, false, new OpenAlexProvider({ cache: outageCache, fetch: async () => new Response('', { status: 503 }) }));
  const stale = await outage.graph(['W3']);
  assert.equal(stale.meta.fetchedAt, oldTime);
  assert.match(`${stale.meta.warning} ${stale.meta.coverage}`, /unavailable.*stale/i);
  assert.equal(await outageCache.get('graph:v1:W3'), undefined, 'fallback must not acquire a new fresh TTL');
  const stalePaper = await outage.paper('W4');
  assert.equal(stalePaper.meta.fetchedAt, oldTime);
  assert.match(stalePaper.meta.warning!, /unavailable.*stale/i);
});

test('fresh exact-origin hydrated pools avoid expansion, offline containing pools disclose limited coverage', async t => {
  const { cache } = await setup(t);
  await cache.set('pool:W1', pool('W1'));
  let calls = 0;
  const provider = new OpenAlexProvider({ cache, fetch: async () => { calls++; throw new Error('Unexpected traffic'); } });
  const service = new PaperService(cache, false, provider);
  assert.equal((await service.graph(['W1'])).meta.fetchedAt, oldTime);
  assert.equal(calls, 0);
  const selected = snapshot.groups[0].papers.find(p => p.id !== snapshot.groups[0].origin)!;
  const offline = await new PaperService(cache, true, provider).graph([selected.id]);
  assert.match(offline.meta.coverage, /no.*(?:expanded|origin).*neighborhood/i);
  assert.match(offline.meta.warning!, /Offline/);
});

test('malformed normalized entries including null papers cannot poison hydration or direct cache reads', async t => {
  const { directory, cache } = await setup(t);
  await cache.set('pool:W1', { ...pool('W1'), papers: [null] });
  await cache.set('pool:W2', { ...pool('W2'), coverage: null });
  await cache.set('paper:W3', { paper: { ...normalizeWork(work('W3')), references: [null] }, meta: { source: 'cache', fetchedAt: oldTime } });
  await cache.set('search:1:malformed', { results: [null], meta: { source: 'cache', fetchedAt: oldTime }, total: 1, page: 1, perPage: 20 });
  await cache.set('graph:v1:W1', { origins: ['W1'], nodes: [null], edges: [], prior: [], derivative: [], meta: {} });
  const service = new PaperService(new PersistentCache(directory), true);
  await service.ready;
  assert.equal((await service.search('malformed', 1)).results.length, 0);
  await assert.rejects(service.paper('W3'), /offline collection/);
  await assert.rejects(service.graph(['W1']), /offline collection/);
});

test('collection provenance follows returned objects despite concurrent calls and a saturated rolling log', async t => {
  const { cache } = await setup(t);
  const origin = work('W1');
  const citing: WorksPage = { results: [], meta: { count: 0 } };
  const provider = new OpenAlexProvider({ cache });
  provider.metadata = data => data === origin ? { source: 'cache', fetchedAt: '2010-01-01T00:00:00.000Z' } : { source: 'live', fetchedAt: oldTime };
  provider.batch = async () => [];
  provider.request = async <T extends WorksPage | OpenAlexWork>() => {
    // Other requests can rotate the global log while this collection is awaiting its response.
    provider.acquisitions.shift();
    provider.acquisitions.push({ path: '/works/W999', params: {}, fetchedAt: '2020-01-01T00:00:00.000Z', responseSha256: '', resultCount: 1, total: 1, creditsUsed: null, fromCache: true });
    return citing as T;
  };
  provider.acquisitions.push(...Array.from({ length: 250 }, () => ({ path: '/works', params: {}, fetchedAt: '2020-01-01T00:00:00.000Z', responseSha256: '', resultCount: 0, total: 0, creditsUsed: null, fromCache: true })));
  const result = await collectCandidates(provider, origin);
  assert.equal(result.source, 'live');
  assert.equal(result.fetchedAt, oldTime);
});

test('real empty live page retains provenance after the provider log reaches its 250-entry cap', async t => {
  const { cache } = await setup(t);
  const key = `oa:/works/W1?select=${encodeURIComponent(SELECT)}`;
  await cache.set(key, work('W1'));
  await cache.set(`provenance:${key}`, { path: '/works/W1', params: { select: SELECT }, fetchedAt: oldTime,
    responseSha256: 'a'.repeat(64), resultCount: 1, total: 1, creditsUsed: null, hashKind: 'original-response' });
  let calls = 0;
  const provider = new OpenAlexProvider({ cache, fetch: async () => {
    calls++;
    return Response.json({ results: [], meta: { count: 0 } });
  } });
  let origin = work('W1');
  for (let i = 0; i < 250; i++) origin = await provider.getPaper('W1');
  assert.equal(provider.acquisitions.length, 250);
  const result = await collectCandidates(provider, origin);
  assert.equal(calls, 1);
  assert.equal(provider.acquisitions.length, 250);
  assert.equal(result.source, 'live');
  assert.equal(result.fetchedAt, oldTime);
});
