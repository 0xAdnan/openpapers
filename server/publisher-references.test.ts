import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PersistentCache } from './cache.ts';
import { OpenAlexProvider, type OpenAlexWork } from './openalex.ts';
import { PaperService } from './service.ts';
import { PublisherReferences } from './publisher-references.ts';
import { normalizeWork, SELECT } from './openalex.ts';

const origin: OpenAlexWork = { id: 'https://openalex.org/W99', doi: 'https://doi.org/10.1234/origin',
  display_name: 'Synthetic new repair paper', referenced_works: [], related_works: [], cited_by_count: 0 };
const record = { DOI: '10.1234/origin', title: ['Synthetic new repair paper'],
  reference: [{ DOI: '10.1234/ref' }, { DOI: '10.1234/ref' }, { DOI: '10.1234/missing' }, { unstructured: 'Not guessed from text.' }] };

async function setup(t: test.TestContext, message = record) {
  const directory = await mkdtemp(join(tmpdir(), 'publisher-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = new PersistentCache(directory);
  let crossrefCalls = 0;
  const oaCalls: URL[] = [];
  const publisher = new PublisherReferences(cache, { fetch: async (input, options) => {
    crossrefCalls++;
    assert.equal(new URL(String(input)).origin, 'https://api.crossref.org');
    assert.equal(options?.redirect, 'error');
    return Response.json({ message });
  } });
  const provider = new OpenAlexProvider({ cache, fetch: async input => {
    const url = new URL(String(input)); oaCalls.push(url);
    if (url.pathname === '/works/W99') return Response.json(origin);
    const filter = url.searchParams.get('filter') ?? '';
    if (filter.startsWith('doi:')) return Response.json({ results: [
      { id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1234/ref', display_name: 'Synthetic cited reference' },
      { id: 'https://openalex.org/W2', doi: 'https://doi.org/10.1234/not-requested', display_name: 'Unrelated record' },
      { id: 'https://openalex.org/W3', doi: 'https://doi.org/10.1234/missing', display_name: 'Ambiguous reference' },
      { id: 'https://openalex.org/W4', doi: 'https://doi.org/10.1234/missing', display_name: 'Same DOI, another work' },
    ], meta: { count: 4 } });
    return Response.json({ results: filter.startsWith('cites:') ? [origin] : [], meta: { count: filter.startsWith('cites:') ? 1 : 0 } });
  } });
  const service = new PaperService(cache, false, provider, undefined, publisher);
  return { service, publisher, cache, provider, directory, oaCalls, crossrefCalls: () => crossrefCalls };
}

test('missing OpenAlex bibliography recovers only exact publisher DOI references and replaces legacy singleton pools', async t => {
  const f = await setup(t);
  const graph = await f.service.graph(['W99']);
  assert.ok(graph.nodes.length > 1);
  assert.deepEqual(graph.nodes.find(p => p.id === 'W99')!.references, ['W1']);
  assert.ok(graph.edges.some(edge => edge.source === 'W99' && edge.target === 'W1' || edge.target === 'W99' && edge.source === 'W1'));
  assert.ok(!graph.nodes.some(p => p.id === 'W2'));
  assert.ok(!graph.nodes.some(p => ['W3', 'W4'].includes(p.id)), 'ambiguous DOI identities do not create edges');
  assert.match(graph.meta.coverage, /Crossref.*1\/2/);
  assert.equal(f.crossrefCalls(), 1);
  const cold = new PaperService(new PersistentCache(f.directory), false, f.provider, undefined, f.publisher);
  await cold.graph(['W99']);
  assert.equal(f.crossrefCalls(), 1, 'supplemented pools survive restarts');
  await f.publisher.lookup(origin);
  assert.equal(f.crossrefCalls(), 1, 'publisher bibliography itself is cached');
  const pool = (await f.cache.get<{ papers: typeof graph.nodes; referenceRecovery?: string }>('pool:W99'))!.value;
  await f.cache.set('pool:W99', { ...pool, referenceRecovery: undefined, papers: [graph.nodes.find(p => p.isOrigin)!].map(p => ({ ...p, references: [] })) });
  const refreshed = await new PaperService(f.cache, false, f.provider, undefined, f.publisher).graph(['W99']);
  assert.ok(refreshed.nodes.length > 1, 'legacy singleton cache must not hide publisher recovery');
  assert.deepEqual(origin.referenced_works, [], 'never mutate cached upstream metadata');
});

test('offline singleton recovery is never attempted and unsuccessful recovery has a short pool lifetime', async t => {
  const f = await setup(t, { ...record, DOI: '10.1234/wrong' });
  await f.service.graph(['W99']);
  const pool = await f.cache.get('pool:W99');
  assert.ok(pool && pool.expiresAt <= Date.now() + 31000);
  const calls = f.crossrefCalls();
  const offline = new PaperService(f.cache, true, f.provider, undefined, f.publisher);
  assert.equal((await offline.graph(['W99'])).nodes.length, 1);
  assert.equal(f.crossrefCalls(), calls);
  const raw = await f.cache.get(`oa:/works/W99?select=${encodeURIComponent(SELECT)}`);
  assert.ok(raw);
  assert.deepEqual(normalizeWork(raw.value as OpenAlexWork).references, []);
});

for (const change of [{ DOI: '10.1234/wrong' }, { title: ['Wrong paper'] }]) {
  test(`publisher origin identity fails closed: ${JSON.stringify(change)}`, async t => {
    const f = await setup(t, { ...record, ...change });
    const graph = await f.service.graph(['W99']);
    assert.equal(graph.nodes.length, 1);
    assert.ok(!f.oaCalls.some(url => url.searchParams.get('filter')?.startsWith('doi:')));
    assert.match(graph.meta.coverage, /Publisher reference recovery unavailable/);
  });
}

test('publisher lookup is bounded, honours cancellation and never follows arbitrary DOI origins', async t => {
  const f = await setup(t);
  for (const doi of ['https://evil.test/10.1234/x', '10.1234/x|10.1234/y', '10.1234/x,y', '10.1234/x\n', 'https://doi.org/10.1234/x%0A']) {
    assert.equal(await f.publisher.lookup({ ...origin, doi }), undefined);
  }
  assert.equal(f.crossrefCalls(), 0);
  const slow = new PublisherReferences(f.cache, { timeoutMs: 20, fetch: async (_input, options) => {
    await new Promise<void>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true }));
    throw new Error('unreachable');
  } });
  assert.equal(await slow.lookup(origin), undefined);
  const controller = new AbortController();
  controller.abort(new Error('User cancelled'));
  await assert.rejects(f.publisher.lookup(origin, controller.signal), /User cancelled/);
});
