import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentCache } from './cache.ts';
import { OPENALEX_ORIGIN, OpenAlexProvider, ProviderError, SELECT, type OpenAlexWork, type WorksPage } from './openalex.ts';

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'openalex-pages-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, cache: new PersistentCache(directory) };
}

const work: OpenAlexWork = {
  id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1234/fixture', display_name: 'OpenAlex transport fixture',
  publication_year: 2020, authorships: [{ author: { display_name: 'Fixture Author' } }],
  primary_location: { source: { display_name: 'Fixture Journal' }, landing_page_url: 'https://example.org/paper' },
  best_oa_location: { pdf_url: 'https://example.org/paper.pdf' }, open_access: { is_oa: true },
  cited_by_count: 101, referenced_works: ['https://openalex.org/W200'], related_works: ['https://openalex.org/W201'],
  abstract_inverted_index: { Transport: [0], fixture: [1] }, topics: [{ display_name: 'Transport' }],
};
const params = { filter: 'cites:W200', per_page: '100', select: SELECT, sort: 'cited_by_count:desc', cursor: '*' };

test('real /works response fixtures preserve cursor pagination, 100-work pages, provenance and header-only keys across restart', async t => {
  const { directory, cache } = await setup(t);
  const secret = 'test-openalex-header-only-key';
  const cursor = 'IlsyMDIwLCAxMDFdIg==+/opaque';
  const fixtures: WorksPage[] = [
    { results: [work, ...Array.from({ length: 99 }, (_, i) => ({ ...work, id: `https://openalex.org/W${i + 2}` }))], meta: { count: 101, next_cursor: cursor } },
    { results: [{ ...work, id: 'https://openalex.org/W101' }], meta: { count: 101, next_cursor: null } },
  ];
  const texts = fixtures.map(fixture => JSON.stringify(fixture));
  let calls = 0;
  const provider = new OpenAlexProvider({ cache, apiKey: secret, fetch: async (input, options) => {
    const url = new URL(String(input));
    assert.equal(url.origin, OPENALEX_ORIGIN);
    assert.equal(url.pathname, '/works');
    assert.equal(url.searchParams.get('per_page'), '100');
    assert.equal(url.searchParams.get('select'), SELECT);
    assert.equal(url.searchParams.get('filter'), params.filter);
    assert.equal(url.searchParams.get('cursor'), calls === 0 ? '*' : cursor);
    assert.equal(url.searchParams.has('page'), false);
    assert.equal(url.searchParams.has('api_key'), false);
    assert.equal(url.href.includes(secret), false);
    assert.equal(new Headers(options?.headers).get('Authorization'), `Bearer ${secret}`);
    assert.equal(options?.redirect, 'error');
    return new Response(texts[calls++], { headers: { 'Content-Type': 'application/json', 'x-ratelimit-credits-used': '1' } });
  } });
  const first = await provider.request<WorksPage>('/works', params);
  const secondParams = { ...params, cursor: first.meta.next_cursor! };
  const second = await provider.request<WorksPage>('/works', secondParams);
  assert.deepEqual(first, fixtures[0]);
  assert.deepEqual(second, fixtures[1]);
  assert.equal(second.meta.next_cursor, null);
  assert.equal(new Set([...first.results, ...second.results].map(record => record.id)).size, 101);
  for (const [i, page] of [first, second].entries()) {
    const acquisition = provider.acquisitions[i];
    assert.equal(acquisition.resultCount, page.results.length);
    assert.equal(acquisition.total, 101);
    assert.equal(acquisition.hashKind, 'original-response');
    assert.equal(acquisition.responseSha256, createHash('sha256').update(texts[i]).digest('hex'));
    assert.equal(acquisition.creditsUsed, '1');
    assert.deepEqual(provider.metadata(page), { source: 'live', fetchedAt: acquisition.fetchedAt });
    assert.ok(Number.isFinite(Date.parse(acquisition.fetchedAt)));
    assert.deepEqual(provider.metadata(page.results[0]), provider.metadata(page));
  }
  const restarted = new OpenAlexProvider({ cache: new PersistentCache(directory), offline: true, fetch: async () => {
    throw new Error('Cached cursor pages must not fetch');
  } });
  for (const [i, requestParams] of [params, secondParams].entries()) {
    const page = await restarted.request<WorksPage>('/works', requestParams);
    assert.deepEqual(page, fixtures[i]);
    assert.equal(restarted.metadata(page).source, 'cache');
    assert.equal(restarted.metadata(page).fetchedAt, provider.acquisitions[i].fetchedAt);
    assert.equal(restarted.acquisitions[i].fromCache, true);
    assert.equal(restarted.acquisitions[i].responseSha256, provider.acquisitions[i].responseSha256);
  }
  assert.equal(calls, 2);
  assert.equal(JSON.stringify(provider.acquisitions).includes(secret), false);
  assert.equal((await readFile(join(directory, 'openalex-cache-v1.json'), 'utf8')).includes(secret), false);
});

test('missing, null and exactly 2000-character cursors remain compatible on live and cached pages', async t => {
  const { directory, cache } = await setup(t);
  const fixtures: WorksPage[] = [
    { results: [work], meta: { count: 1 } },
    { results: [], meta: { count: 0, next_cursor: null } },
    { results: [work], meta: { count: 2, next_cursor: 'x'.repeat(2000) } },
  ];
  let calls = 0;
  const provider = new OpenAlexProvider({ cache, fetch: async () => Response.json(fixtures[calls++]) });
  for (const [i, fixture] of fixtures.entries()) {
    assert.deepEqual(await provider.request<WorksPage>('/works', { ...params, cursor: String(i) }), fixture);
  }
  const restarted = new OpenAlexProvider({ cache: new PersistentCache(directory), offline: true });
  for (const [i, fixture] of fixtures.entries()) {
    const page = await restarted.request<WorksPage>('/works', { ...params, cursor: String(i) });
    assert.deepEqual(page, fixture);
    assert.equal(Object.hasOwn(page.meta, 'next_cursor'), i !== 0);
  }
  assert.equal(calls, fixtures.length);
});

test('invalid cursor, count and unknown-record schemas fail safely and are never cached', async t => {
  const { cache } = await setup(t);
  const invalid: unknown[] = [
    ...['', 'x'.repeat(2001), 1, false, {}, []].map(next_cursor => ({ results: [work], meta: { count: 1, next_cursor } })),
    ...[-1, 1.5, '1', null].map(count => ({ results: [work], meta: { count } })),
    { results: [work] }, { results: [work], meta: [] }, { results: {} , meta: { count: 1 } },
    ...[null, {}, { id: 'W0' }, { id: 'https://evil.example/W1' }, { id: 1 }].map(record => ({ results: [record], meta: { count: 1 } })),
    { results: Array.from({ length: 101 }, () => work), meta: { count: 101 } },
    null, [],
  ];
  for (const fixture of invalid) {
    const provider = new OpenAlexProvider({ cache, fetch: async () => Response.json(fixture) });
    await assert.rejects(provider.request('/works', params), error => error instanceof ProviderError && error.status === 502 &&
      error.message === 'Invalid OpenAlex response');
    assert.deepEqual(provider.acquisitions, []);
  }
  assert.deepEqual(await cache.list('oa:'), []);
  const provider = new OpenAlexProvider({ cache, fetch: async () => Response.json({ id: 'https://openalex.org/W2' }) });
  await assert.rejects(provider.getPaper('W1'), error => error instanceof ProviderError && error.status === 502);
});

test('corrupt cached cursor pages are rejected offline and refetched live', async t => {
  const { directory, cache } = await setup(t);
  const key = 'oa:/works?cursor=*&per_page=100';
  await cache.set(key, { results: [work], meta: { count: 1, next_cursor: {} } });
  const requestParams = { cursor: '*', per_page: '100' };
  const offline = new OpenAlexProvider({ cache: new PersistentCache(directory), offline: true });
  await assert.rejects(offline.request('/works', requestParams), error => error instanceof ProviderError && error.status === 503);
  let calls = 0;
  const fixture: WorksPage = { results: [work], meta: { count: 1, next_cursor: null } };
  const live = new OpenAlexProvider({ cache, fetch: async () => { calls++; return Response.json(fixture); } });
  assert.deepEqual(await live.request('/works', requestParams), fixture);
  assert.equal(calls, 1);
});

test('invalid cached provenance dates fall back to the valid original cache timestamp', async t => {
  const { directory, cache } = await setup(t);
  const key = 'oa:/works?per_page=100';
  const fixture: WorksPage = { results: [work], meta: { count: 1 } };
  await cache.set(key, fixture);
  const storedAt = (await cache.get(key))!.storedAt;
  for (const fetchedAt of ['not-a-date', null, 123]) {
    await cache.set(`provenance:${key}`, { fetchedAt });
    const provider = new OpenAlexProvider({ cache: new PersistentCache(directory), offline: true });
    const page = await provider.request<WorksPage>('/works', { per_page: '100' });
    assert.equal(provider.metadata(page).fetchedAt, storedAt);
    assert.ok(Number.isFinite(Date.parse(provider.metadata(page).fetchedAt)));
    assert.equal(provider.acquisitions[0].hashKind, 'reserialized-json');
  }
});

test('HTTP 400, 401, 403, 404 and 429 stay distinct while upstream 5xx stay 503 without private bodies', async t => {
  const { cache } = await setup(t);
  const secret = 'test-private-upstream-key-and-body';
  for (const status of [400, 401, 403, 404, 429, 500, 502, 503, 504]) {
    const provider = new OpenAlexProvider({ cache, apiKey: secret, fetch: async () => new Response(secret, { status }) });
    await assert.rejects(provider.getPaper('W1'), error => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.status, status >= 500 ? 503 : status);
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.stack?.includes(secret), false);
      assert.equal(JSON.stringify(error).includes(secret), false);
      assert.equal(error.retryAfter, status === 429 ? 3600 : undefined);
      return true;
    });
    assert.deepEqual(provider.acquisitions, []);
  }
  assert.deepEqual(await cache.list('oa:'), []);
});

test('429 numeric/date Retry-After is bounded and its actual cooldown expires without an extra fetch', async t => {
  const { cache } = await setup(t);
  const base = Date.parse('2026-10-13T12:00:00.000Z');
  let now = base;
  t.mock.method(Date, 'now', () => now);
  const cases: [string | undefined, number][] = [
    ['120', 120], ['120.2', 121], ['0', 60], ['10', 60],
    [new Date(base + 7200 * 1000).toUTCString(), 7200],
    [new Date(base - 1000).toUTCString(), 60],
    ['999999999999999', 86400], [new Date(base + 7 * 86400 * 1000).toUTCString(), 86400],
    [undefined, 3600], ['', 3600], ['invalid-private-header', 3600],
  ];
  for (const [header, seconds] of cases) {
    now = base;
    let calls = 0;
    const provider = new OpenAlexProvider({ cache, fetch: async () => {
      calls++;
      return new Response('Private upstream body', { status: 429, headers: header === undefined ? {} : { 'Retry-After': header } });
    } });
    await assert.rejects(provider.getPaper('W1'), error => error instanceof ProviderError && error.status === 429 && error.retryAfter === seconds);
    now += (seconds - 1) * 1000;
    await assert.rejects(provider.getPaper('W2'), error => error instanceof ProviderError && error.status === 429 && error.retryAfter === 1);
    assert.equal(calls, 1);
    now += 1000;
    await assert.rejects(provider.getPaper('W3'), error => error instanceof ProviderError && error.status === 429);
    assert.equal(calls, 2, 'Cooldown should expire at Retry-After, not a fixed hour');
  }
});

test('network errors retain sanitized 503s and a 30-second retryable cooldown', async t => {
  const { cache } = await setup(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  const provider = new OpenAlexProvider({ cache, fetch: async () => { calls++; throw new Error('Private network error'); } });
  await assert.rejects(provider.getPaper('W1'), error => error instanceof ProviderError && error.status === 503 && error.message === 'OpenAlex is unavailable');
  now += 1000;
  await assert.rejects(provider.getPaper('W2'), error => error instanceof ProviderError && error.status === 503 && error.retryAfter === 29);
  assert.equal(calls, 1);
  now += 29000;
  await assert.rejects(provider.getPaper('W3'), error => error instanceof ProviderError && error.status === 503);
  assert.equal(calls, 2);
});

test('429 status is preserved even if cancelling the private error body fails', async t => {
  const { cache } = await setup(t);
  const provider = new OpenAlexProvider({ cache, fetch: async () => new Response(new ReadableStream({
    cancel() { throw new Error('Private cancellation failure'); },
  }), { status: 429, headers: { 'Retry-After': '120' } }) });
  await assert.rejects(provider.getPaper('W1'), error => error instanceof ProviderError && error.status === 429 && error.retryAfter === 120);
});

test('default budgets remain bounded and maxRequests 1500 allows the persistent worker budget', async t => {
  const { cache } = await setup(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  // Avoid disk churn while exercising every request through the real transport/parser.
  t.mock.method(cache, 'set', async () => {});
  for (const options of [{ expected: 50 }, { apiKey: 'test-budget-key', expected: 250 }, { maxRequests: 1500, expected: 1500 }]) {
    let calls = 0;
    const provider = new OpenAlexProvider({ cache, ...options, fetch: async input => {
      calls++;
      now += 250;
      return Response.json({ id: `https://openalex.org/${new URL(String(input)).pathname.split('/').pop()}` });
    } });
    for (let i = 1; i <= options.expected; i++) await provider.getPaper(`W${i}`);
    assert.equal(calls, options.expected);
    await assert.rejects(provider.getPaper(`W${options.expected + 1}`), error => error instanceof ProviderError && error.status === 503 &&
      typeof error.retryAfter === 'number' && error.retryAfter > 0 && error.retryAfter <= 86400);
    assert.equal(calls, options.expected);
  }
});
