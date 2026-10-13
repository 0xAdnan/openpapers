import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CandidatePoolSchema, GraphResponseSchema, PaperResponseSchema, SearchResponseSchema } from '../shared/schemas.ts';
import type { DataMeta, GraphResponse, Paper, SearchResponse } from '../shared/types.ts';
import { PersistentCache } from './cache.ts';
import { buildGraph, ALGORITHM } from './graph.ts';
import { normalizeWork, OpenAlexProvider } from './openalex.ts';
import { normalizeSemanticPaper, SemanticScholarProvider } from './semantic-scholar.ts';
import { SemanticService } from './semantic-service.ts';
import { ApiError, PaperService } from './service.ts';

const fetchedAt = '2001-01-01T00:00:00.000Z';
const legacyMeta: DataMeta = { source: 'live', fetchedAt };
const s2Meta: DataMeta = { ...legacyMeta, provider: 'semantic-scholar' };
const s2Id = (n: number) => `S2:${n.toString(16).padStart(40, '0')}`;
const s2Paper = (n: number) => normalizeSemanticPaper({ paperId: s2Id(n).slice(3), title: `Foreign fixture ${n}`, references: [] });
const oaPaper = (id: string, references: string[] = []): Paper => ({
  ...normalizeWork({ id: `https://openalex.org/${id}`, display_name: `Local fixture ${id}` }), references,
});
const search = (results: Paper[], meta: DataMeta = legacyMeta): SearchResponse => ({ results, total: results.length, page: 1, perPage: 20, meta });
const pool = (origin: string, papers: Paper[], provider?: DataMeta['provider']) => ({
  origin, papers, provider, source: 'live' as const, fetchedAt, coverage: 'Provider-scoped fixture',
});
const graphMeta: GraphResponse['meta'] = { ...legacyMeta, candidateCount: 4, algorithm: ALGORITHM, coverage: 'Provider-scoped fixture' };

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'providers-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, cache: new PersistentCache(directory) };
}

test('OpenAlex rejects misnamespaced full-S2, mixed-reference and foreign-provider search caches without hydration', async t => {
  const { directory, cache } = await setup(t);
  const invalid = [
    search([s2Paper(1)], s2Meta),
    search([s2Paper(2)]),
    search([s2Paper(3)], { ...legacyMeta, provider: 'openalex' }),
    search([oaPaper('W900001', [s2Id(4)])]),
    search([oaPaper('W900002')], s2Meta),
    search([oaPaper('W900003'), s2Paper(5)]),
    search([], s2Meta),
  ];
  for (const [i, response] of invalid.entries()) {
    assert.equal(SearchResponseSchema.safeParse(response).success, true);
    await cache.set(`search:1:foreignfixture${i}`, response, i % 2 ? -1 : 60000);
  }
  let calls = 0;
  const restarted = new PersistentCache(directory);
  const provider = new OpenAlexProvider({ cache: restarted, fetch: async () => { calls++; throw new Error('Unexpected traffic'); } });
  const service = new PaperService(restarted, true, provider);
  for (const [i, response] of invalid.entries()) {
    const result = await service.search(`foreignfixture${i}`, 1);
    assert.deepEqual(result.results, []);
    assert.equal(result.meta.provider, 'openalex');
    for (const paper of response.results) await assert.rejects(service.paper(paper.id), e => e instanceof ApiError && e.status === 404);
  }
  assert.deepEqual((await service.search('fixture', 1)).results, []);
  assert.equal(calls, 0);
});

test('OpenAlex paper caches require W IDs, W references and absent/OpenAlex provider metadata', async t => {
  const { directory, cache } = await setup(t);
  const invalid = [
    { paper: oaPaper('W900001', [s2Id(1)]), meta: legacyMeta },
    { paper: oaPaper('W900002'), meta: s2Meta },
    { paper: s2Paper(3), meta: legacyMeta },
  ];
  for (const response of invalid) {
    assert.equal(PaperResponseSchema.safeParse(response).success, true);
    await cache.set(`paper:${response.paper.id}`, response);
  }
  const service = new PaperService(new PersistentCache(directory), true);
  for (const response of invalid) await assert.rejects(service.paper(response.paper.id), e => e instanceof ApiError && e.status === 404);
  assert.deepEqual((await service.search('fixture', 1)).results, []);
});

test('OpenAlex candidate pool hydration rejects foreign origins, papers, references and providers', async t => {
  const { directory, cache } = await setup(t);
  const invalid = [
    pool(s2Id(1), [s2Paper(1)]),
    pool('W900001', [oaPaper('W900001'), s2Paper(2)]),
    pool('W900002', [oaPaper('W900002', [s2Id(3)])]),
    pool('W900003', [oaPaper('W900003')], 'semantic-scholar'),
  ];
  for (const response of invalid) {
    assert.equal(CandidatePoolSchema.safeParse(response).success, true);
    await cache.set(`pool:${response.origin}`, response);
  }
  const service = new PaperService(new PersistentCache(directory), true);
  for (const response of invalid) {
    await assert.rejects(service.graph([response.origin]), e => e instanceof ApiError && e.status === 404);
    for (const paper of response.papers) await assert.rejects(service.paper(paper.id), e => e instanceof ApiError && e.status === 404);
  }
  assert.deepEqual((await service.search('fixture', 1)).results, []);
});

test('OpenAlex graph caches reject mixed origins/edges, nodes, prior/derivative references and metadata', async t => {
  const { directory, cache } = await setup(t);
  const origin = 'W900001';
  const papers = [oaPaper(origin, ['W900010']), oaPaper('W900002', ['W900010']),
    oaPaper('W900003', [origin, 'W900002']), oaPaper('W900010')];
  const base = buildGraph(papers, [origin], graphMeta);
  assert.equal(base.edges.length, 1);
  assert.equal(base.prior.length, 1);
  assert.equal(base.derivative.length, 1);
  const mixed = buildGraph([papers[0], { ...s2Paper(1), references: ['W900010'] }], [origin, s2Id(1)], graphMeta);
  const edge = buildGraph([papers[0], { ...s2Paper(1), references: ['W900010'] }], [origin], graphMeta);
  const invalid = [
    mixed,
    edge,
    { ...base, nodes: base.nodes.map(p => ({ ...p, references: [s2Id(2)] })) },
    { ...base, prior: base.prior.map(p => ({ ...p, id: s2Id(3) })) },
    { ...base, prior: base.prior.map(p => ({ ...p, references: [s2Id(4)] })) },
    { ...base, derivative: base.derivative.map(p => ({ ...p, id: s2Id(5) })) },
    { ...base, derivative: base.derivative.map(p => ({ ...p, references: [s2Id(6)] })) },
    { ...base, meta: { ...base.meta, provider: 'semantic-scholar' as const } },
  ];
  const service = new PaperService(cache, true);
  await service.ready;
  for (const response of invalid) {
    assert.equal(GraphResponseSchema.safeParse(response).success, true, 'Fixture must pass the generic graph schema');
    await cache.set(`graph:v1:${response.origins.join(',')}`, response);
    await assert.rejects(service.graph(response.origins), e => e instanceof ApiError && e.status === 404);
  }
  // Outage fallback must reject the same graph instead of relabeling it as OpenAlex.
  await cache.set(`graph:v1:${origin}`, edge, -1);
  const restarted = new PersistentCache(directory);
  let calls = 0;
  const provider = new OpenAlexProvider({ cache: restarted, fetch: async () => { calls++; return new Response('', { status: 503 }); } });
  await assert.rejects(new PaperService(restarted, false, provider).graph([origin]), e => e instanceof ApiError && e.status === 503);
  assert.equal(calls, 1);
});

test('legacy and explicitly OpenAlex caches keep dates and gain explicit provider metadata', async t => {
  const { directory, cache } = await setup(t);
  for (const [i, provider] of [undefined, 'openalex' as const].entries()) {
    const paper = oaPaper(`W90000${i + 1}`), meta = { ...legacyMeta, provider };
    await cache.set(`paper:${paper.id}`, { paper, meta });
    await cache.set(`search:1:localfixture${i}`, search([paper], meta));
    await cache.set(`pool:${paper.id}`, pool(paper.id, [paper], provider));
    await cache.set(`graph:v1:${paper.id}`, buildGraph([paper], [paper.id], { ...graphMeta, provider }));
  }
  const service = new PaperService(new PersistentCache(directory), true);
  for (let i = 0; i < 2; i++) {
    const id = `W90000${i + 1}`;
    for (const response of [await service.paper(id), await service.search(`localfixture${i}`, 1), await service.graph([id])]) {
      assert.equal(response.meta.source, 'cache');
      assert.equal(response.meta.provider, 'openalex');
      assert.equal(response.meta.fetchedAt, fetchedAt);
    }
  }
  const example = (await service.examples())[0];
  for (const response of [await service.paper(example.id), await service.search(example.id, 1), await service.graph([example.id])]) {
    assert.equal(response.meta.provider, 'openalex');
  }
});

test('Semantic Scholar live paper followed by in-memory reuse reports cache source without renewing provenance', async t => {
  const { directory, cache } = await setup(t);
  let calls = 0;
  const provider = new SemanticScholarProvider({ cache, fetch: async () => {
    calls++; return Response.json({ paperId: s2Id(1).slice(3), title: 'Live S2 fixture', references: [] });
  } });
  const service = new SemanticService(cache, false, provider);
  const live = await service.paper(s2Id(1));
  const before = (await cache.get(`s2:paper:v1:${s2Id(1)}`, true))!;
  assert.equal(live.meta.source, 'live');
  const reused = await service.paper(s2Id(1));
  assert.equal(reused.meta.source, 'cache');
  assert.equal(reused.meta.provider, 'semantic-scholar');
  assert.equal(reused.meta.fetchedAt, live.meta.fetchedAt);
  assert.deepEqual(reused.paper, live.paper);
  const after = (await cache.get(`s2:paper:v1:${s2Id(1)}`, true))!;
  assert.equal(after.expiresAt, before.expiresAt);
  assert.equal(after.storedAt, before.storedAt);
  const offline = new SemanticService(new PersistentCache(directory), true, provider);
  const persisted = await offline.paper(s2Id(1));
  assert.equal(persisted.meta.source, 'cache');
  assert.equal(persisted.meta.fetchedAt, live.meta.fetchedAt);
  assert.equal(calls, 1);
});
