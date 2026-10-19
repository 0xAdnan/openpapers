import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CandidatePoolSchema, GraphResponseSchema } from '../shared/schemas.ts';
import type { DataMeta } from '../shared/types.ts';
import { PersistentCache } from './cache.ts';
import { ALGORITHM, buildGraph } from './graph.ts';
import { ApiError } from './service.ts';
import { SemanticService } from './semantic-service.ts';
import { normalizeSemanticPaper, SemanticScholarError, SemanticScholarProvider, type SemanticPaper } from './semantic-scholar.ts';

const sha = (n: number) => n.toString(16).padStart(40, '0');
const id = (n: number) => `S2:${sha(n)}`;
const record = (n: number, refs?: number[]): SemanticPaper => ({ paperId: sha(n), title: `Synthetic partial fixture ${n}`,
  ...(refs ? { references: refs.map(n => ({ paperId: sha(n) })) } : {}) });
const oldTime = '2001-01-01T00:00:00.000Z';

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'semantic-partial-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = new PersistentCache(directory);
  const provider = new SemanticScholarProvider({ cache, fetch: async () => { throw new Error('No real network allowed'); } });
  const records = new Map([record(1, [2, 3]), record(2, [3]), record(3, [2]), record(4, [1, 2])].map(p => [id(Number.parseInt(p.paperId, 16)), p]));
  const calls: string[] = [];
  const provenance = new WeakMap<object, { meta: DataMeta; expiresAt: number }>();
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  const stamp = <T extends object>(data: T, fetchedAt = '2020-01-01T00:00:00.000Z', expiry = expiresAt, source: DataMeta['source'] = 'live') => {
    provenance.set(data, { meta: { provider: 'semantic-scholar', source, fetchedAt }, expiresAt: expiry });
    return data;
  };
  provider.metadata = data => { assert.ok(provenance.has(data), 'Only successful returned objects have provenance'); return provenance.get(data)!.meta; };
  provider.expiresAt = data => { assert.ok(provenance.has(data)); return provenance.get(data)!.expiresAt; };
  provider.getPaper = async lookup => { calls.push(`origin:${lookup}`); return stamp(records.get(lookup)!); };
  provider.references = async () => { calls.push('references'); return stamp({ offset: 0, data: [2, 3].map(n => ({ citedPaper: record(n) })) }); };
  provider.citations = async () => { calls.push('citations'); return stamp({ offset: 0, data: [{ citingPaper: record(4) }] }); };
  provider.batch = async ids => { calls.push(`batch:${ids.join(',')}`); return stamp(ids.flatMap(key => records.has(key) ? [records.get(key)!] : [])); };
  const service = new SemanticService(cache, false, provider);
  return { directory, cache, provider, records, calls, stamp, expiresAt, service };
}

test('full collection hydrates references before acquiring citations and retains the scoring formula', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { service, calls, expiresAt, cache } = await setup(t);
  const graph = await service.graph([id(1)]);
  assert.deepEqual(calls, [`origin:${id(1)}`, 'references', `batch:${id(2)},${id(3)}`, 'citations', `batch:${id(4)}`]);
  assert.equal(graph.meta.algorithm, ALGORITHM);
  assert.equal(graph.meta.candidateCount, 4);
  assert.equal(GraphResponseSchema.safeParse(graph).success, true);
  assert.match(graph.meta.coverage, /first 1 citing records/);
  assert.ok(!graph.meta.warning?.includes('Partial'));
  assert.equal((await cache.get(`s2:pool:v1:${id(1)}`))!.expiresAt, expiresAt);
});

for (const status of [429, 500]) test(`citation ${status} preserves hydrated references and honest sample coverage`, async t => {
  const { service, provider, calls, cache, records } = await setup(t);
  records.get(id(1))!.citationCount = 13;
  provider.citations = async () => { calls.push('citations'); throw new SemanticScholarError(status, 'Private upstream detail', status === 429 ? 60 : undefined); };
  const before = Date.now();
  const graph = await service.graph([id(1)]);
  assert.equal(graph.meta.candidateCount, 3);
  assert.equal(graph.nodes.length, 3);
  assert.ok(graph.edges.length > 0);
  assert.deepEqual(calls, [`origin:${id(1)}`, 'references', `batch:${id(2)},${id(3)}`, 'citations']);
  assert.match(graph.meta.warning!, /Partial.*citations.*unavailable/);
  assert.match(graph.meta.coverage, /citing records were not fetched/);
  assert.match(graph.meta.coverage, /Co-citation.*reference papers/);
  assert.ok(!graph.meta.coverage.includes('13 citing'));
  assert.ok(!graph.meta.warning!.includes('Private upstream'));
  const entry = (await cache.get(`s2:pool:v1:${id(1)}`))!;
  assert.equal(CandidatePoolSchema.safeParse(entry.value).success, true);
  const ttl = status === 429 ? 60000 : 300000;
  assert.ok(entry.expiresAt >= before + ttl && entry.expiresAt <= Date.now() + ttl);
});

test('citation cooldown suppresses common-reference hydration, even with unresolved common IDs', async t => {
  const { service, provider, records, calls } = await setup(t);
  records.set(id(2), record(2, [3, 10]));
  provider.citations = async () => { calls.push('citations'); throw new SemanticScholarError(429, undefined, 120); };
  const graph = await service.graph([id(1)]);
  assert.equal(calls.length, 4);
  assert.match(graph.meta.warning!, /common-reference hydration.*cooldown/);
  assert.match(graph.meta.warning!, /retry after 120 seconds/);
  assert.equal(graph.nodes.find(p => p.id === id(2))!.references.includes(id(10)), true);
  assert.match(graph.meta.coverage, /0 common-reference records/);
});

test('unavailable references endpoint falls back to actual origin IDs before citations', async t => {
  const { service, provider, calls } = await setup(t);
  provider.references = async () => { calls.push('references'); throw new SemanticScholarError(500); };
  const graph = await service.graph([id(1)]);
  assert.deepEqual(calls, [`origin:${id(1)}`, 'references', `batch:${id(2)},${id(3)}`, 'citations', `batch:${id(4)}`]);
  assert.equal(graph.meta.candidateCount, 4);
  assert.match(graph.meta.coverage, /2 origin-returned reference IDs/);
  assert.match(graph.meta.warning!, /references endpoint.*unavailable/);
});

test('references 429 does not issue subsequent acquisition calls or invent ID-only metadata', async t => {
  const { service, provider, calls } = await setup(t);
  provider.references = async () => { calls.push('references'); throw new SemanticScholarError(429, undefined, 60); };
  const graph = await service.graph([id(1)]);
  assert.deepEqual(calls, [`origin:${id(1)}`, 'references']);
  assert.equal(graph.meta.candidateCount, 1);
  assert.deepEqual(graph.edges, []);
  assert.deepEqual(graph.nodes[0].references, [id(2), id(3)]);
  assert.match(graph.meta.warning!, /reference hydration.*cooldown/);
  assert.match(graph.meta.warning!, /citations.*cooldown/);
});

test('failed reference hydration keeps BasePaper metadata with explicitly missing outgoing lists', async t => {
  const { service, provider, calls } = await setup(t);
  provider.batch = async () => { calls.push('failed-batch'); throw new SemanticScholarError(429, undefined, 60); };
  const graph = await service.graph([id(1)]);
  assert.deepEqual(calls, [`origin:${id(1)}`, 'references', 'failed-batch']);
  assert.equal(graph.nodes.length, 3);
  assert.deepEqual(graph.nodes.find(p => p.id === id(2))!.references, []);
  assert.match(graph.meta.coverage, /2 records have missing references.*empty arrays/);
  assert.match(graph.meta.warning!, /reference hydration.*unavailable/);
});

for (const status of [429, 500]) test(`citing-paper hydration ${status} retains prior reference evidence and citing metadata`, async t => {
  const { service, provider, calls, records } = await setup(t);
  records.set(id(2), record(2, [3, 10]));
  const batch = provider.batch.bind(provider);
  provider.batch = async (ids, signal) => {
    if (ids.includes(id(4))) { calls.push('citer-hydration-failed'); throw new SemanticScholarError(status, undefined, 60); }
    return batch(ids, signal);
  };
  const graph = await service.graph([id(1)]);
  assert.equal(graph.meta.candidateCount, 4);
  assert.deepEqual(graph.nodes.find(p => p.id === id(2))!.references, [id(3), id(10)]);
  assert.match(graph.meta.warning!, /citing-paper hydration.*unavailable/);
  assert.match(graph.meta.coverage, /first 1 citing records/);
  if (status === 429) assert.equal(calls.at(-1), 'citer-hydration-failed');
  else assert.equal(calls.at(-1), `batch:${id(10)}`);
  const stored = (await service.cache.get<{ papers: ReturnType<typeof normalizeSemanticPaper>[] }>(`s2:pool:v1:${id(1)}`))!;
  assert.deepEqual(stored.value.papers.find(p => p.id === id(4))!.references, []);
});

test('real provider with mocked transport preserves references and sends nothing after citation 429', async t => {
  const { cache, records } = await setup(t);
  records.set(id(1), record(1));
  records.set(id(2), record(2, [3, 10]));
  const paths: string[] = [];
  const provider = new SemanticScholarProvider({ cache, apiKey: 'synthetic-test-key', fetch: async (input, options) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname.endsWith('/references')) return Response.json({ offset: 0, data: [2, 3].map(n => ({ citedPaper: record(n) })) });
    if (url.pathname.endsWith('/batch')) {
      const ids = JSON.parse(options!.body as string).ids as string[];
      assert.deepEqual(ids, [sha(2), sha(3)]);
      return Response.json(ids.map(hash => records.get(`S2:${hash}`)));
    }
    if (url.pathname.endsWith('/citations')) return new Response('Private rate-limit body', { status: 429, headers: { 'Retry-After': '60' } });
    assert.equal(url.pathname, `/graph/v1/paper/${sha(1)}`);
    return Response.json(records.get(id(1)));
  } });
  const service = new SemanticService(cache, false, provider);
  const graph = await service.graph([id(1)]);
  assert.equal(graph.meta.candidateCount, 3);
  assert.equal(graph.nodes.length, 3);
  assert.deepEqual(graph.nodes[0].references, [id(2), id(3)]);
  assert.deepEqual(paths, [`/graph/v1/paper/${sha(1)}`, `/graph/v1/paper/${sha(1)}/references`,
    '/graph/v1/paper/batch', `/graph/v1/paper/${sha(1)}/citations`]);
  assert.equal((await service.graph([id(1)])).meta.source, 'cache');
  assert.equal(paths.length, 4);
  assert.match(graph.meta.warning!, /common-reference hydration.*cooldown/);
  const raw = await cache.list<{ meta: DataMeta }>('s2:raw:v1:');
  assert.equal(graph.meta.fetchedAt, raw.map(entry => entry.value.meta.fetchedAt).sort()[0]);
  const cachedOrigin = await provider.getPaper(id(1));
  assert.equal(cachedOrigin.references, undefined);
  assert.equal(cachedOrigin.abstract, undefined);
  assert.equal(paths.length, 4);
  assert.ok(!graph.meta.warning!.includes('Private rate-limit body'));
});

test('optional common-reference failure preserves the complete first-hop graph', async t => {
  const { service, provider, records, calls, cache } = await setup(t);
  records.set(id(2), record(2, [3, 10]));
  const batch = provider.batch.bind(provider);
  provider.batch = async (ids, signal) => {
    if (ids.includes(id(10))) { calls.push('common-failed'); throw new SemanticScholarError(500); }
    return batch(ids, signal);
  };
  const graph = await service.graph([id(1)]);
  assert.equal(graph.meta.candidateCount, 4);
  assert.match(graph.meta.warning!, /common-reference hydration.*unavailable/);
  assert.equal(calls.at(-1), 'common-failed');
  assert.ok((await cache.get(`s2:pool:v1:${id(1)}`))!.expiresAt <= Date.now() + 300000);
});

test('successful empty pages and all-null batches retain oldest successful provenance', async t => {
  const { service, provider, stamp } = await setup(t);
  provider.references = async () => stamp({ offset: 0, data: [
    { citedPaper: record(2) }, { citedPaper: null }, { citedPaper: { paperId: null, title: 'Unknown' } },
  ] }, oldTime, Date.now() + 60000, 'cache');
  provider.batch = async () => stamp([], '2010-01-01T00:00:00.000Z');
  provider.citations = async () => stamp({ offset: 0, data: [] });
  const graph = await service.graph([id(1)]);
  assert.equal(graph.meta.fetchedAt, oldTime);
  assert.equal(graph.meta.source, 'live');
  assert.equal(graph.meta.candidateCount, 2);
  assert.match(graph.meta.coverage, /first 3 origin-reference records/);
  assert.match(graph.meta.warning!, /reference hydration.*1.*not returned/);
});

test('observed reference IDs replace null origin references without mutating raw metadata or inventing papers', async t => {
  const { service, provider, records, stamp, cache } = await setup(t);
  const origin = Object.freeze({ ...record(1), references: null });
  records.set(id(1), origin);
  provider.references = async () => stamp({ offset: 0, data: [
    { citedPaper: record(2) }, { citedPaper: { ...record(2), paperId: sha(2).toUpperCase() } },
    { citedPaper: { paperId: sha(8), title: null } }, { citedPaper: null },
    { citedPaper: { paperId: null, title: 'Unknown reference' } }, { citedPaper: record(1) },
  ] }, oldTime, Date.now() + 60000, 'cache');
  provider.batch = async () => stamp([]);
  provider.citations = async () => stamp({ offset: 0, data: [] });
  const graph = await service.graph([id(1)]);
  assert.equal(graph.meta.fetchedAt, oldTime);
  assert.equal(graph.meta.source, 'live');
  assert.equal(graph.meta.candidateCount, 2);
  assert.deepEqual(graph.nodes.map(p => p.id), [id(1), id(2)]);
  assert.deepEqual(graph.nodes[0].references, [id(2), id(8)]);
  assert.deepEqual(graph.edges, [{ source: id(1), target: id(2), weight: 0, sharedReferences: 0, coCitations: 0, directCitation: true }]);
  assert.deepEqual(graph.nodes[1].references, []);
  assert.equal(graph.nodes[1].abstract, '');
  assert.equal(graph.nodes[1].year, null);
  assert.equal(origin.references, null);
  assert.match(graph.meta.warning!, /1 optional records.*missing or blank titles.*skipped/);
  const stored = (await cache.get<{ papers: ReturnType<typeof normalizeSemanticPaper>[] }>(`s2:pool:v1:${id(1)}`))!;
  assert.deepEqual(stored.value.papers.find(p => p.id === id(1))!.references, [id(2), id(8)]);
  assert.ok(!stored.value.papers.some(p => p.id === id(8)));
  assert.equal(GraphResponseSchema.safeParse(graph).success, true);
});

test('observed reference IDs union with known origin IDs and remain normalized and capped at 2,500', async t => {
  const { service, provider, records, stamp } = await setup(t);
  const references = [{ paperId: null }, { paperId: sha(1) }, { paperId: sha(5) }, { paperId: sha(5) },
    ...Array.from({ length: 2497 }, (_, i) => ({ paperId: sha(i + 10) }))];
  records.set(id(1), Object.freeze({ ...record(1), references: Object.freeze(references) as unknown as SemanticPaper['references'] }));
  provider.citations = async () => stamp({ offset: 0, data: [] });
  provider.batch = async () => { throw new SemanticScholarError(429, undefined, 60); };
  const graph = await service.graph([id(1)]);
  const originReferences = graph.nodes[0].references;
  assert.equal(originReferences.length, 2500);
  assert.equal(new Set(originReferences).size, 2500);
  assert.equal(originReferences[0], id(5));
  assert.deepEqual(originReferences.slice(-2), [id(2), id(3)]);
  assert.ok(!originReferences.includes(id(1)));
  assert.equal(records.get(id(1))!.references, references);
});

test('missing and blank optional BasePaper titles are skipped while hydration 429 retains valid evidence', async t => {
  const { service, provider, records, calls, stamp, cache } = await setup(t);
  records.set(id(1), record(1));
  provider.references = async () => { calls.push('references'); return stamp({ offset: 0, data: [
    { citedPaper: record(2) }, { citedPaper: { paperId: sha(3), title: null } },
    { citedPaper: { paperId: sha(8), title: '  ' } }, { citedPaper: { paperId: sha(9) } },
  ] }); };
  provider.batch = async () => { calls.push('failed-batch'); throw new SemanticScholarError(429, undefined, 60); };
  const graph = await service.graph([id(1)]);
  assert.deepEqual(calls, [`origin:${id(1)}`, 'references', 'failed-batch']);
  assert.equal(graph.meta.candidateCount, 2);
  assert.deepEqual(graph.nodes[0].references, [id(2), id(3), id(8), id(9)]);
  assert.equal(graph.nodes[1].id, id(2));
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].directCitation, true);
  assert.match(graph.meta.warning!, /3 optional records.*missing or blank titles.*skipped/);
  assert.match(graph.meta.warning!, /reference hydration.*rate limited/);
  assert.equal(CandidatePoolSchema.safeParse((await cache.get(`s2:pool:v1:${id(1)}`))!.value).success, true);
});

test('unusable optional hydration cannot replace valid BasePaper metadata or poison the remaining graph', async t => {
  const { service, provider, records, stamp } = await setup(t);
  records.set(id(1), record(1));
  records.set(id(2), { ...record(2, [3]), title: null });
  records.set(id(8), { paperId: sha(8), title: null });
  records.set(id(9), { paperId: sha(9), title: ' ' });
  provider.batch = async ids => stamp(ids.flatMap(key => records.has(key) ? [records.get(key)!] : []));
  provider.citations = async () => stamp({ offset: 0, data: [
    { citingPaper: { paperId: sha(8), title: null } }, { citingPaper: { paperId: sha(9), title: ' ' } },
  ] });
  const graph = await service.graph([id(1)]);
  assert.equal(graph.meta.candidateCount, 3);
  assert.deepEqual(graph.nodes.find(p => p.id === id(2))!.references, []);
  assert.deepEqual(graph.nodes.find(p => p.id === id(3))!.references, [id(2)]);
  assert.match(graph.meta.warning!, /5 optional records.*missing or blank titles.*skipped/);
  assert.equal(GraphResponseSchema.safeParse(graph).success, true);
});

test('empty complete acquisition stays origin-only without hydration calls or partial TTL', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { service, provider, records, calls, stamp, cache, expiresAt } = await setup(t);
  records.set(id(1), record(1, []));
  provider.references = async () => { calls.push('references'); return stamp({ offset: 0, data: [] }); };
  provider.citations = async () => { calls.push('citations'); return stamp({ offset: 0, data: [] }); };
  const graph = await service.graph([id(1)]);
  assert.equal(graph.nodes.length, 1);
  assert.deepEqual(graph.edges, []);
  assert.deepEqual(calls, [`origin:${id(1)}`, 'references', 'citations']);
  assert.equal((await cache.get(`s2:pool:v1:${id(1)}`))!.expiresAt, expiresAt);
  assert.ok(!graph.meta.warning?.includes('Partial'));
});

test('partial cache is served without traffic until expiry, then re-expands after restart', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { service, provider, calls, directory, cache, stamp } = await setup(t);
  provider.citations = async () => { calls.push('citations'); throw new SemanticScholarError(429, undefined, 60); };
  const first = await service.graph([id(1)]);
  const expiry = (await cache.get(`s2:pool:v1:${id(1)}`))!.expiresAt;
  assert.equal((await service.graph([id(1)])).meta.source, 'cache');
  assert.equal(calls.length, 4);
  t.mock.timers.tick(59000);
  const restartedCache = new PersistentCache(directory);
  const restarted = new SemanticService(restartedCache, false, provider);
  assert.equal((await restarted.graph([id(1)])).meta.fetchedAt, first.meta.fetchedAt);
  assert.equal(calls.length, 4);
  assert.equal((await restartedCache.get(`s2:pool:v1:${id(1)}`))!.expiresAt, expiry);
  t.mock.timers.tick(1001);
  provider.citations = async () => { calls.push('citations-recovered'); return stamp({ offset: 0, data: [{ citingPaper: record(4) }] }); };
  const expanded = await restarted.graph([id(1)]);
  assert.equal(expanded.meta.candidateCount, 4);
  assert.equal(calls.length, 9);
  assert.ok(!expanded.meta.warning?.includes('Partial'));
});

test('stale partial outage fallback preserves its original pool and graph expiry without renewal', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { service, provider, directory, cache } = await setup(t);
  provider.citations = async () => { throw new SemanticScholarError(429, undefined, 60); };
  const first = await service.graph([id(1)]);
  const poolExpiry = (await cache.get(`s2:pool:v1:${id(1)}`))!.expiresAt;
  const graphExpiry = (await cache.get(`s2:graph:v1:${id(1)}`))!.expiresAt;
  t.mock.timers.tick(60001);
  provider.getPaper = async () => { throw new SemanticScholarError(500); };
  const restartedCache = new PersistentCache(directory);
  const restarted = new SemanticService(restartedCache, false, provider);
  const stale = await restarted.graph([id(1)]);
  assert.equal(stale.meta.fetchedAt, first.meta.fetchedAt);
  assert.match(stale.meta.warning!, /stale cached graph/);
  assert.match(stale.meta.warning!, /Partial.*citations/);
  assert.equal((await restartedCache.get(`s2:pool:v1:${id(1)}`, true))!.expiresAt, poolExpiry);
  assert.equal((await restartedCache.get(`s2:graph:v1:${id(1)}`, true))!.expiresAt, graphExpiry);
  assert.equal(await restartedCache.get(`s2:graph:v1:${id(1)}`), undefined);
});

test('expired partial graph rejects a genuine origin 404 even when transport lease release fails', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { service, provider, directory, cache } = await setup(t);
  provider.citations = async () => { throw new SemanticScholarError(429, undefined, 60); };
  await service.graph([id(1)]);
  const poolExpiry = (await cache.get(`s2:pool:v1:${id(1)}`))!.expiresAt;
  const graphExpiry = (await cache.get(`s2:graph:v1:${id(1)}`))!.expiresAt;
  t.mock.timers.tick(60001);
  const restartedCache = new PersistentCache(directory);
  let calls = 0, releases = 0;
  const missing = new SemanticScholarProvider({ cache: restartedCache, rateLimiter: { reserve: async () => ({
    assertValid() {}, release: async () => { releases++; throw new Error('Private lease failure'); },
  }) }, fetch: async input => {
    calls++;
    assert.equal(new URL(String(input)).pathname, `/graph/v1/paper/${sha(1)}`);
    return new Response('Private missing-paper response', { status: 404 });
  } });
  const restarted = new SemanticService(restartedCache, false, missing);
  await assert.rejects(restarted.graph([id(1)]), e => e instanceof ApiError && e.status === 404 && !e.message.includes('Private'));
  assert.equal(calls, 1);
  assert.equal(releases, 1);
  assert.equal((await restartedCache.get(`s2:pool:v1:${id(1)}`, true))!.expiresAt, poolExpiry);
  assert.equal((await restartedCache.get(`s2:graph:v1:${id(1)}`, true))!.expiresAt, graphExpiry);
  assert.deepEqual(await restartedCache.list('s2:raw:'), []);
});

for (const retryAfter of [60, 120, 600, 7200]) test(`partial rate-limit TTL follows ${retryAfter}s cooldown, capped at one hour`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { service, provider, cache } = await setup(t);
  provider.citations = async () => { throw new SemanticScholarError(429, undefined, retryAfter); };
  const now = Date.now();
  await service.graph([id(1)]);
  assert.equal((await cache.get(`s2:pool:v1:${id(1)}`))!.expiresAt, now + Math.min(3600, retryAfter) * 1000);
});

test('partial acquisition never renews stale raw TTL or substitutes another provider cache', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { service, provider, cache, stamp, records } = await setup(t);
  const expiry = Date.now() - 1000;
  provider.getPaper = async () => stamp(records.get(id(1))!, oldTime, expiry, 'cache');
  provider.citations = async () => { throw new SemanticScholarError(500); };
  await cache.set(`pool:v1:${id(1)}`, { origin: 'W1', papers: [], fetchedAt: oldTime });
  const graph = await service.graph([id(1)]);
  assert.equal(graph.meta.fetchedAt, oldTime);
  assert.equal(await cache.get(`s2:pool:v1:${id(1)}`), undefined);
  assert.equal((await cache.get(`s2:pool:v1:${id(1)}`, true))!.expiresAt, expiry);
  assert.equal(await cache.get(`s2:graph:v1:${id(1)}`), undefined);
});

test('mandatory origin failure and identity mismatch cannot become partial success', async t => {
  for (const status of [404, 429, 500]) {
    const { service, provider, cache, calls } = await setup(t);
    provider.getPaper = async () => { calls.push('origin-failed'); throw new SemanticScholarError(status, undefined, 60); };
    await assert.rejects(service.graph([id(1)]), e => e instanceof ApiError && e.status === (status === 404 ? 404 : 503));
    assert.deepEqual(calls, ['origin-failed']);
    assert.deepEqual(await cache.list('s2:pool:'), []);
  }
  const { service, provider, stamp } = await setup(t);
  provider.getPaper = async () => stamp(record(2, []));
  await assert.rejects(service.graph([id(1)]), e => e instanceof ApiError && e.status === 503);
  for (const title of [null, undefined, ' ']) {
    provider.getPaper = async () => stamp({ ...record(1), title });
    await assert.rejects(service.graph([id(1)]), e => e instanceof ApiError && e.status === 503);
  }
});

test('cancellation during optional acquisition still aborts instead of caching a partial graph', async t => {
  const { service, provider, cache } = await setup(t);
  const controller = new AbortController();
  provider.citations = async () => { controller.abort(new Error('Cancelled acquisition')); throw controller.signal.reason; };
  await assert.rejects(service.graph([id(1)], controller.signal), /Cancelled acquisition/);
  assert.deepEqual(await cache.list('s2:pool:'), []);
  assert.deepEqual(await cache.list('s2:graph:'), []);
});

for (const omitReferences of [false, true]) test(`reference-only synthetic 38-paper neighborhood retains 39 nodes and 123 native edges${omitReferences ? ' with origin references omitted' : ''}`, async t => {
  const { service, provider, records, stamp, calls } = await setup(t);
  const references = Array.from({ length: 38 }, (_, i) => i + 2);
  records.set(id(1), record(1, omitReferences ? undefined : references));
  let seed = 45;
  for (const n of references) {
    const outgoing = references.filter(target => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return target !== n && seed / 2 ** 32 < 0.05;
    });
    records.set(id(n), record(n, outgoing));
  }
  provider.references = async () => { calls.push('references'); return stamp({ offset: 0, data: references.map(n => ({ citedPaper: record(n) })) }); };
  provider.citations = async () => { calls.push('citations'); throw new SemanticScholarError(429, undefined, 60); };
  const graph = await service.graph([id(1)]);
  const native = buildGraph([...records.values()].filter(p => Number.parseInt(p.paperId, 16) <= 39)
    .map(p => normalizeSemanticPaper(p.paperId === sha(1) ? record(1, references) : p)), [id(1)], graph.meta);
  assert.equal(graph.nodes.length, 39);
  assert.equal(graph.edges.length, 123);
  assert.deepEqual(graph.edges, native.edges);
  assert.equal(graph.meta.algorithm, ALGORITHM);
  assert.equal(calls.length, 4);
  assert.deepEqual(graph.nodes[0].references, references.map(id));
  if (omitReferences) assert.equal(records.get(id(1))!.references, undefined);
  assert.ok(graph.edges.every(edge => edge.sharedReferences + edge.coCitations > 0 || edge.directCitation));
});
