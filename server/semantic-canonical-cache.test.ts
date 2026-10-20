import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataMeta } from '../shared/types.ts';
import { PersistentCache } from './cache.ts';
import { SemanticRateLimitError, type SemanticRateLimiter } from './semantic-rate-limit.ts';
import { SemanticService } from './semantic-service.ts';
import { semanticLookup, SemanticScholarError, SemanticScholarProvider, S2_FULL_FIELDS, S2_ORIGIN,
  type SemanticPaper } from './semantic-scholar.ts';

const hash = 'a'.repeat(40);
const id = `S2:${hash}`;
const raw: SemanticPaper = { paperId: hash.toUpperCase(), title: 'Synthetic canonical fixture',
  externalIds: { ArXiv: '1706.03762', DOI: '10.1234/test/thing' }, references: [{ paperId: null }] };
const meta: DataMeta = { provider: 'semantic-scholar', source: 'live',
  fetchedAt: '2026-10-01T12:00:00.000Z', warning: 'Original fixture provenance.' };
const rawKey = (lookup: string, fields = S2_FULL_FIELDS) => {
  const url = new URL(`/graph/v1/paper/${encodeURIComponent(lookup)}`, S2_ORIGIN);
  url.searchParams.set('fields', fields);
  return `s2:raw:v1:GET:${url.pathname}${url.search}`;
};
const canonicalKey = rawKey(hash);

async function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const directory = await mkdtemp(join(tmpdir(), 'semantic-canonical-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, cache: new PersistentCache(directory) };
}

test('arXiv identity lookup warms the native canonical GET without another request or reservation, including restart cooldown', async t => {
  const { directory, cache } = await setup(t);
  let calls = 0, reservations = 0;
  let cooldown = false;
  const rateLimiter: SemanticRateLimiter = { reserve: async () => {
    reservations++;
    if (cooldown) throw new SemanticRateLimitError(429, 'Synthetic cooldown', 60);
    return { assertValid() {}, release: async () => {} };
  } };
  const provider = new SemanticScholarProvider({ cache, apiKey: 'private-canonical-test-key', rateLimiter,
    fetch: async (input, options) => {
      calls++;
      assert.equal(options?.method, 'GET');
      const url = new URL(String(input));
      assert.equal(url.pathname, '/graph/v1/paper/ARXIV%3A1706.03762');
      assert.equal(url.searchParams.get('fields'), S2_FULL_FIELDS);
      return Response.json(raw);
    } });
  const alias = await provider.getPaper('arxiv:1706.03762v2');
  const fetchedAt = provider.metadata(alias).fetchedAt, expiry = provider.expiresAt(alias);
  cooldown = true;
  const canonical = await provider.getPaper(id);
  assert.deepEqual(canonical, alias);
  assert.equal(provider.metadata(canonical).source, 'cache');
  assert.equal(provider.metadata(canonical).fetchedAt, fetchedAt);
  assert.equal(provider.expiresAt(canonical), expiry);
  assert.equal(calls, 1);
  assert.equal(reservations, 1);
  const stored = (await cache.get<{ data: SemanticPaper; meta: DataMeta }>(canonicalKey))!;
  assert.deepEqual(stored.value, { data: alias, meta: provider.metadata(alias) });
  assert.equal(stored.expiresAt, expiry);
  assert.deepEqual((await cache.list('s2:raw:')).map(entry => entry.key).sort(),
    [rawKey('ARXIV:1706.03762'), canonicalKey].sort());
  assert.ok(!(await readFile(join(directory, 'openalex-cache-v1.json'), 'utf8')).includes('private-canonical-test-key'));
  const restarted = new SemanticScholarProvider({ cache: new PersistentCache(directory),
    apiKey: 'different-private-key', rateLimiter, fetch: async () => {
      calls++; throw new Error('No network allowed after restart');
    } });
  const recovered = await restarted.getPaper(hash);
  assert.deepEqual(recovered, alias);
  assert.equal(restarted.metadata(recovered).source, 'cache');
  assert.equal(restarted.metadata(recovered).fetchedAt, fetchedAt);
  assert.equal(restarted.expiresAt(recovered), expiry);
  assert.equal(calls, 1);
  assert.equal(reservations, 1);
});

test('cached alias lookup preserves original expiry when warming canonical key and never downgrades fresher canonical data', async t => {
  const { cache } = await setup(t);
  const aliasKey = rawKey('DOI:10.1234/test/thing');
  const initialExpiry = Date.now() + 2 * 60 * 60 * 1000;
  await cache.set(aliasKey, { data: raw, meta }, initialExpiry - Date.now());
  t.mock.timers.tick(30 * 60 * 1000);
  const provider = new SemanticScholarProvider({ cache, fetch: async () => { throw new Error('Unexpected network call'); } });
  const fromAlias = await provider.getPaper('https://doi.org/10.1234/test/thing');
  assert.equal(provider.expiresAt(fromAlias), initialExpiry);
  const canonical = (await cache.get<{ data: SemanticPaper; meta: DataMeta }>(canonicalKey))!;
  assert.equal(canonical.expiresAt, initialExpiry);
  assert.equal(canonical.value.meta.fetchedAt, meta.fetchedAt);

  const newerRaw: SemanticPaper = { ...raw, title: 'Newer canonical record' };
  const newerMeta: DataMeta = { ...meta, fetchedAt: '2026-10-02T00:00:00.000Z' };
  const newerExpiry = initialExpiry + 60 * 60 * 1000;
  await cache.set(canonicalKey, { data: newerRaw, meta: newerMeta }, newerExpiry - Date.now());
  await provider.getPaper('DOI:10.1234/test/thing');
  const preserved = (await cache.get<{ data: SemanticPaper; meta: DataMeta }>(canonicalKey))!;
  assert.equal(preserved.value.data.title, 'Newer canonical record');
  assert.equal(preserved.value.meta.fetchedAt, newerMeta.fetchedAt);
  assert.equal(preserved.expiresAt, newerExpiry);
});

test('stale offline alias does not warm a fresh canonical entry and SemanticService.graph reuses warmed origin', async t => {
  const { cache } = await setup(t);
  const aliasKey = rawKey('ARXIV:1706.03762');
  await cache.set(aliasKey, { data: raw, meta }, -1000);
  const offlineProvider = new SemanticScholarProvider({ cache, offline: true });
  const staleAlias = await offlineProvider.getPaper('ARXIV:1706.03762');
  assert.equal( staleAlias.paperId, raw.paperId);
  assert.equal(await cache.get(canonicalKey, true), undefined);

  await cache.set(aliasKey, { data: raw, meta }, 60 * 60 * 1000);
  const paths: string[] = [];
  const rateLimiter: SemanticRateLimiter = { reserve: async () => ({ assertValid() {}, release: async () => {} }) };
  const onlineProvider = new SemanticScholarProvider({ cache, rateLimiter, fetch: async input => {
    const pathname = new URL(String(input)).pathname;
    paths.push(pathname);
    if (pathname.endsWith('/references')) return Response.json({ offset: 0, data: [] });
    if (pathname.endsWith('/citations')) return Response.json({ offset: 0, data: [] });
    throw new SemanticScholarError(500, `Unexpected request to ${pathname}`);
  } });
  await onlineProvider.getPaper('ARXIV:1706.03762');
  const service = new SemanticService(cache, false, onlineProvider);
  const graph = await service.graph([id]);
  assert.deepEqual(paths, [`/graph/v1/paper/${hash}/references`, `/graph/v1/paper/${hash}/citations`]);
  assert.equal(graph.origins[0], id);
});
