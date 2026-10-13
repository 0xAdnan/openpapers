import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentCache } from './cache.ts';
import { PaperService } from './service.ts';
import { OpenAlexProvider, normalizeWork } from './openalex.ts';
import { SEEDS, auditedConflict, seedConflict } from './integrity.ts';

async function serviceFor(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'openpapers-integrity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = new PersistentCache(directory);
  const provider = new OpenAlexProvider({ cache, fetch: async () => { throw new Error('No provider traffic allowed'); } });
  return { service: new PaperService(cache, true, provider), cache };
}

test('unresolved Attention seed conflict is explicit in search, graph and paper metadata without rewriting records', async t => {
  const { service } = await serviceFor(t);
  const example = (await service.examples()).find(e => e.field === 'Machine Learning')!;
  assert.equal(example.id, 'W2626778328', 'No independently verified replacement ID was found');
  assert.equal(example.year, 2025, 'Example must retain returned metadata, not claim verified 2017');
  assert.match(example.warning!, /Data integrity warning/);
  for (const query of ['Attention Is All You Need', example.id, '10.48550/arXiv.1706.03762']) {
    const result = await service.search(query, 1);
    assert.equal(result.results[0].id, example.id);
    assert.equal(result.results[0].doi, 'https://doi.org/10.65215/2q58a426');
    assert.equal(result.results[0].year, 2025);
    assert.match(result.meta.warning!, /Data integrity warning/);
    assert.match(result.meta.warning!, /10\.48550\/arxiv\.1706\.03762/);
    assert.match(result.meta.warning!, /10\.65215\/2q58a426/);
    assert.match(result.meta.warning!, /2017/);
    assert.match(result.meta.warning!, /2025/);
  }
  const graph = await service.graph([example.id]);
  assert.match(graph.meta.warning!, /Data integrity warning/);
  assert.match(graph.meta.warning!, /sample-local/);
  assert.equal(graph.nodes.find(p => p.isOrigin)!.year, 2025);
  assert.match((await service.paper(example.id)).meta.warning!, /Data integrity warning/);
  const biology = (await service.examples()).find(e => e.field === 'Biology')!;
  assert.doesNotMatch((await service.graph([biology.id])).meta.warning!, /Data integrity warning/);
});

test('audited non-seed publication conflicts are disclosed only while their metadata still matches the audit', async t => {
  const { service } = await serviceFor(t);
  const response = await service.paper('W4385245566');
  assert.match(response.meta.warning!, /publication-identity conflict/);
  assert.match(response.meta.warning!, /MizAR|publisher DOI identity/);
  assert.ok(auditedConflict(response.paper));
  assert.equal(auditedConflict({ ...response.paper, title: 'Independently corrected publisher title' }), undefined);
});

test('persisted pre-warning graph and search responses cannot hide the seed conflict', async t => {
  const { service, cache } = await serviceFor(t);
  const id = (await service.examples()).find(e => e.field === 'Machine Learning')!.id;
  const graph = await service.graph([id]);
  const search = await service.search('Attention Is All You Need', 1);
  graph.meta.warning = 'Old cache warning.';
  search.meta.warning = 'Old cache warning.';
  await cache.set(`graph:v1:${id}`, graph);
  await cache.set('search:1:attention is all you need', search);
  for (const response of [await service.graph([id]), await service.search('Attention Is All You Need', 1)]) {
    assert.equal(response.meta.source, 'cache');
    assert.match(response.meta.warning!, /Data integrity warning/);
    assert.match(response.meta.warning!, /Offline/);
  }
});

test('seed validation requires returned DOI, year and title, not a title-only alias', () => {
  const seed = SEEDS[0];
  const record = { id: 'https://openalex.org/W1', display_name: 'Attention Is All You Need',
    doi: 'https://doi.org/10.48550/arxiv.1706.03762', publication_year: 2017 };
  const paper = normalizeWork(record);
  assert.equal(seedConflict(paper, seed), undefined);
  for (const changed of [
    { doi: 'https://doi.org/10.65215/2q58a426', year: 2025 },
    { doi: null }, { year: null }, { year: 2025 }, { title: 'Different publication' },
  ]) assert.match(seedConflict({ ...paper, ...changed }, seed)!, /Data integrity warning/);
  assert.equal(paper.doi, record.doi);
  assert.equal(paper.year, 2017);
});

test('live DOI responses with a different ID still expose seed conflicts and preserve provider provenance', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'openpapers-integrity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = new PersistentCache(directory);
  let calls = 0;
  const provider = new OpenAlexProvider({ cache, fetch: async () => {
    calls++;
    return Response.json({ results: [{ id: 'https://openalex.org/W1', display_name: 'Attention Is All You Need',
      doi: 'https://doi.org/10.65215/2q58a426', publication_year: 2025 }], meta: { count: 1 } });
  } });
  const service = new PaperService(cache, false, provider);
  const response = await service.search(SEEDS[0].doi, 1);
  assert.equal(response.meta.source, 'live');
  assert.equal(response.meta.fetchedAt, provider.acquisitions[0].fetchedAt);
  assert.equal(response.results[0].id, 'W1');
  assert.match(response.meta.warning!, /Data integrity warning/);
  assert.match((await service.search(SEEDS[0].doi, 1)).meta.warning!, /Data integrity warning/);
  assert.equal(calls, 1);
});

test('outage fallback on an expired pre-warning search preserves both integrity and availability warnings', async t => {
  const { service: offline, cache } = await serviceFor(t);
  const response = await offline.search('Attention Is All You Need', 1);
  response.meta.warning = 'Pre-integrity cache.';
  await cache.set('search:1:attention is all you need', response, -1);
  const provider = new OpenAlexProvider({ cache, fetch: async () => new Response('Unavailable', { status: 503 }) });
  const online = new PaperService(cache, false, provider);
  const stale = await online.search('Attention Is All You Need', 1);
  assert.equal(stale.meta.source, 'cache');
  assert.equal(stale.meta.fetchedAt, response.meta.fetchedAt);
  assert.match(stale.meta.warning!, /Data integrity warning/);
  assert.match(stale.meta.warning!, /stale cached matches/);
});
