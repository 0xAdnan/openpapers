import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg, { type PoolConfig } from 'pg';
import { PersistentCache } from './cache.ts';
import { PersistentSemanticCache } from './semantic-database-cache.ts';
import { SemanticScholarProvider, S2_FULL_FIELDS } from './semantic-scholar.ts';
import { SemanticService } from './semantic-service.ts';
import { graphPostgresPoolConfig } from './postgres-store.ts';
import { migrateGraphJobs } from '../scripts/migrate-graph-jobs.ts';
import { createApp } from './index.ts';
import type { GraphJobStore } from './graph-store.ts';

const hash = (key: string) => createHash('sha256').update(key).digest('hex');
const sha = (n: number) => n.toString(16).padStart(40, '0');
const id = `S2:${sha(1)}`;
const rawKey = `s2:raw:v1:GET:/graph/v1/paper/${sha(1)}?fields=${encodeURIComponent(S2_FULL_FIELDS)}`;
const meta = { source: 'live', provider: 'semantic-scholar', fetchedAt: '2026-10-01T12:00:00.000Z' };
const raw = { data: { paperId: sha(1), title: 'Durable fixture', references: [{ paperId: sha(2) }] }, meta };
const paper = { id, title: 'Durable fixture', references: [`S2:${sha(2)}`], authors: [], year: null,
  venue: '', citations: 0, abstract: '', doi: null, url: `https://www.semanticscholar.org/paper/${sha(1)}`,
  pdfUrl: null, openAccess: false, topics: [] };
const poolValue = { origin: id, papers: [paper], fetchedAt: meta.fetchedAt, source: 'live',
  provider: 'semantic-scholar', coverage: 'Acquired fixture, not a corpus snapshot' };

async function directory(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'semantic-durable-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function mockDatabase(t: TestContext) {
  const configs: PoolConfig[] = [], queries: { text: string; values: unknown[] }[] = [];
  let rows: unknown[] = [], fail = false, connections = 0, destroyed = 0;
  t.mock.method(pg, 'Pool', function (config: PoolConfig) {
    configs.push(config);
    return { on() {}, async end() {}, connect(callback: (error: Error | null, client?: unknown) => void) {
      connections++;
      const client = { release(destroy?: boolean) { if (destroy) destroyed++; },
        async query(text: string, values: unknown[] = []) {
          queries.push({ text, values });
          if (fail) throw Object.assign(new Error('postgresql://private:secret@private-host'), { code: '42P01' });
          return { rows: text.startsWith('SELECT\n') ? rows : [], rowCount: 0 };
        } };
      callback(null, client);
    } };
  });
  return { configs, queries, rows: (value: unknown[]) => { rows = value; }, fail: () => { fail = true; },
    connections: () => connections, destroyed: () => destroyed };
}

function dbRow(key = rawKey) {
  return { key_hash: hash(key), cache_key: key, stored_at: new Date(Date.now() - 1000),
    expires_at: new Date(Date.now() + 60000), payload: { version: 1, value: raw }, byte_count: 2000 };
}

test('lazy verified-TLS pool, fresh file hits, original envelopes, safe parameters and non-S2 isolation', async t => {
  const db = mockDatabase(t), path = await directory(t);
  const cache = new PersistentSemanticCache(path, 'postgresql://postgres:dummy@database.example/test?sslmode=verify-full');
  assert.ok(cache instanceof PersistentCache);
  assert.equal(db.configs.length, 0);
  await cache.set('oa:raw:W1', { source: 'openalex' });
  assert.equal(db.configs.length, 0);
  assert.equal(await cache.get('oa:raw:W2'), undefined);
  assert.deepEqual(await cache.list('oa:'), await new PersistentCache(path).list('oa:'));
  assert.deepEqual(await cache.list(''), await new PersistentCache(path).list(''));
  await cache.set(rawKey, raw, 60000);
  const stored = await cache.get(rawKey);
  const before = db.connections();
  assert.deepEqual(await cache.get(rawKey, true), stored);
  assert.equal(db.connections(), before, 'Fresh local reads do not query PostgreSQL');
  assert.equal(db.configs.length, 1);
  assert.equal(db.configs[0].max, 1);
  assert.equal(db.configs[0].allowExitOnIdle, true);
  assert.deepEqual(db.configs[0].ssl, { rejectUnauthorized: true, minVersion: 'TLSv1.2' });
  for (const field of ['connectionTimeoutMillis', 'query_timeout', 'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout'] as const) {
    assert.equal(db.configs[0][field], 5000);
  }
  const insert = db.queries.find(q => q.text.startsWith('INSERT'))!;
  assert.deepEqual(insert.values, [hash(rawKey), rawKey, stored!.storedAt, new Date(stored!.expiresAt).toISOString(), JSON.stringify({ version: 1, value: raw })]);
  assert.ok(db.queries.some(q => q.text.includes('pg_advisory_xact_lock(764521340004)')));
  assert.doesNotMatch(db.queries.map(q => q.text).join('\n'), /CREATE|ALTER|api_key/);
  const cold = new PersistentSemanticCache(await directory(t), 'postgresql://postgres:dummy@database.example/test');
  const row = dbRow(); db.rows([row]);
  assert.deepEqual(await cold.get(rawKey), { key: rawKey, storedAt: row.stored_at.toISOString(), expiresAt: row.expires_at.getTime(), value: raw });
  assert.deepEqual((await cold.get(rawKey))?.storedAt, row.stored_at.toISOString());
  const hostileKey = "s2:search:v1:1:it's 100%_quoted";
  db.rows([dbRow(hostileKey)]);
  await cold.get(hostileKey);
  assert.ok(db.queries.some(q => q.values[1] === hostileKey && !q.text.includes(hostileKey)));
  await cache.close(); await cold.close();
});

test('invalid database rows never become cache hits; provider schemas validate values after envelope validation', async t => {
  const db = mockDatabase(t);
  const cache = new PersistentSemanticCache(await directory(t), 'postgresql://postgres:dummy@localhost/test');
  for (const row of [null, { ...dbRow(), cache_key: 'oa:raw:W1' }, { ...dbRow(), key_hash: 'a'.repeat(64) },
    { ...dbRow(), stored_at: 'bad' }, { ...dbRow(), expires_at: new Date(NaN) },
    { ...dbRow(), stored_at: new Date(Date.now() + 120000) }, { ...dbRow(), expires_at: new Date(Date.now() - 86400001) },
    { ...dbRow(), byte_count: 1 }, { ...dbRow(), byte_count: 4194305 }, { ...dbRow(), payload: { version: 2, value: raw } },
    { ...dbRow(), payload: { version: 1 } }, { ...dbRow(), payload: { version: 1, value: raw, unexpected: true } },
    dbRow('s2:other-key')]) {
    db.rows([row]); assert.equal(await cache.get(rawKey, true), undefined);
  }
  db.rows([{ ...dbRow(), payload: { version: 1, value: { data: { paperId: sha(9), title: 'Wrong identity' }, meta } } }]);
  const provider = new SemanticScholarProvider({ cache, offline: true });
  await assert.rejects(provider.getPaper(id), { status: 503 });
  db.rows([{ ...dbRow(), stored_at: dbRow().stored_at.toISOString(), expires_at: dbRow().expires_at.toISOString() }]);
  assert.equal((await cache.get<{ data: unknown }>(rawKey))?.value.data !== undefined, true);
  await cache.close();
});

test('DB errors preserve file timestamps and only explicitly requested stale values; oversized success stays local', async t => {
  const db = mockDatabase(t), logs: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { logs.push(args); });
  const cache = new PersistentSemanticCache(await directory(t), 'postgresql://postgres:dummy@localhost/test');
  db.fail();
  await cache.set('s2:expired', raw, -1);
  const stored = await PersistentCache.prototype.get.call(cache, 's2:expired', true);
  assert.equal(await cache.get('s2:expired'), undefined);
  assert.deepEqual(await cache.get('s2:expired', true), stored);
  assert.deepEqual(await cache.list('s2:'), [stored]);
  await cache.set('s2:fresh', raw);
  const before = db.connections();
  assert.ok(await cache.get('s2:fresh'));
  assert.equal(db.connections(), before);
  const big = { text: 'x'.repeat(5 * 1024 * 1024) };
  await cache.set('s2:big', big);
  assert.equal(db.connections(), before, 'Oversized values never reach PostgreSQL');
  assert.deepEqual((await cache.get('s2:big'))?.value, big);
  assert.ok(db.destroyed() > 0);
  assert.ok(logs.length > 0);
  for (const log of logs) assert.deepEqual(log, ['Semantic cache database unavailable:', '42P01']);
  await cache.close();
});

test('S2 list merges are prefix-exact, deduplicated, at most 128 entries and 32 MiB', async t => {
  const db = mockDatabase(t), cache = new PersistentSemanticCache(await directory(t), 'postgresql://postgres:dummy@localhost/test');
  await cache.set('s2:pool:v1:local', raw);
  const row = dbRow('s2:pool:v1:local');
  db.rows([row, dbRow('s2:paper:v1:wrong'), ...Array.from({ length: 150 }, (_, i) => dbRow(`s2:pool:v1:${i}`))]);
  const entries = await cache.list('s2:pool:v1:');
  assert.equal(entries.length, 128);
  assert.equal(new Set(entries.map(e => e.key)).size, 128);
  assert.ok(entries.every(e => e.key.startsWith('s2:pool:v1:')));
  const query = db.queries.find(q => q.text.includes('LIMIT 128'))!;
  assert.deepEqual(query.values, ['s2:pool:v1:']);
  assert.match(query.text, /starts_with\(cache_key, \$1\)/);
  db.rows(Array.from({ length: 20 }, (_, i) => ({ ...dbRow(`s2:pool:v1:big-${i}`), byte_count: 4000000,
    payload: { version: 1, value: { text: 'x'.repeat(3 * 1024 * 1024) } } })));
  const bounded = await cache.list('s2:pool:v1:');
  assert.ok(bounded.length < 20);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 32 * 1024 * 1024);
  await cache.close();
});

test('server wiring uses durable cache only for online keyed DB access and skips it for injected SemanticService', async t => {
  const db = mockDatabase(t);
  const saved = { DATABASE_URL: process.env.DATABASE_URL, S2_API_KEY: process.env.S2_API_KEY };
  t.after(() => { for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const jobStore = { ready: Promise.resolve() } as GraphJobStore;
  for (const [offline, apiKey, databaseUrl, injected] of [[true, 'dummy', 'invalid', false],
    [false, '', 'invalid', false], [false, 'dummy', '', false], [false, 'dummy', 'invalid', true],
    [false, 'dummy', 'postgresql://postgres:dummy@localhost/test', false]] as const) {
    process.env.S2_API_KEY = apiKey; process.env.DATABASE_URL = databaseUrl;
    const path = await directory(t);
    const semanticService = injected ? new SemanticService(new PersistentCache(path), true) : undefined;
    const { service } = createApp({ offline, cacheDirectory: path, semanticService, jobStore });
    await service.ready;
    assert.equal(service.cache instanceof PersistentSemanticCache, !offline && !!apiKey && !!databaseUrl && !injected);
    if (service.cache instanceof PersistentSemanticCache) { await delay(20); await service.cache.close(); }
  }
  assert.equal(db.configs.length, 1, 'Injected services do not construct a cache database pool');
});

test('PostgreSQL durable Semantic Scholar cache', { skip: !process.env.GRAPH_TEST_DATABASE_URL, timeout: 120000 }, async t => {
  const root = new URL(process.env.GRAPH_TEST_DATABASE_URL!);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(root.hostname), 'Only explicitly supplied local disposable PostgreSQL is allowed');
  const admin = new pg.Pool(graphPostgresPoolConfig(root.href, { max: 1 }));
  const databaseName = `s2_cache_${randomUUID().replaceAll('-', '')}`;
  let owned = false, sql: pg.Pool | undefined;
  const caches: PersistentSemanticCache[] = [];
  t.after(async () => {
    await Promise.all(caches.map(cache => cache.close()));
    await sql?.end();
    try { if (owned) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`); }
    finally { await admin.end(); }
  });
  assert.equal((await admin.query('SELECT current_user AS owner')).rows[0].owner, 'postgres');
  await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`); owned = true;
  root.pathname = `/${databaseName}`;
  sql = new pg.Pool(graphPostgresPoolConfig(root.href, { max: 2 }));
  await migrateGraphJobs(root.href); await migrateGraphJobs(root.href);
  async function cache(context: TestContext) {
    const result = new PersistentSemanticCache(await directory(context), root.href);
    caches.push(result); return result;
  }
  await t.test('raw first-identity and normalized pools survive empty-directory restart with original provenance', async context => {
    const first = await cache(context);
    await first.set(rawKey, raw, 60000);
    await first.set(`s2:pool:v1:${id}`, poolValue, 60000);
    const stored = await first.get(rawKey), poolStored = await first.get(`s2:pool:v1:${id}`);
    const cold = await cache(context);
    assert.deepEqual(await cold.get(rawKey), stored);
    assert.deepEqual((await cold.list('s2:pool:v1:'))[0], poolStored);
    let calls = 0;
    const provider = new SemanticScholarProvider({ cache: cold, fetch: async () => { calls++; return new Response('', { status: 429 }); } });
    const record = await provider.getPaper(id);
    assert.equal(calls, 0); assert.equal(provider.metadata(record).source, 'cache');
    assert.equal(provider.metadata(record).fetchedAt, meta.fetchedAt);
    assert.equal(provider.expiresAt(record), stored!.expiresAt);
    const service = new SemanticService(cold, false, provider);
    await service.ready;
    assert.equal((await service.paper(id)).paper.id, id);
    const graph = await service.graph([id]);
    assert.equal(graph.meta.fetchedAt, meta.fetchedAt); assert.equal(calls, 0);
    const persisted = (await sql!.query('SELECT * FROM openpapers.semantic_cache WHERE cache_key = $1', [rawKey])).rows[0];
    assert.equal(persisted.stored_at.toISOString(), stored!.storedAt);
    assert.equal(persisted.expires_at.getTime(), stored!.expiresAt);
    assert.deepEqual(persisted.payload, { version: 1, value: raw });
  });
  await t.test('expiry is not renewed, 24-hour stale fallback is warned and older rows are pruned', async context => {
    await sql!.query('TRUNCATE openpapers.semantic_cache');
    const writer = await cache(context);
    await writer.set(`s2:pool:v1:${id}`, poolValue, -1000);
    const original = await writer.get(`s2:pool:v1:${id}`, true);
    await writer.set('s2:prune', raw, -1000);
    await sql!.query("UPDATE openpapers.semantic_cache SET stored_at = stored_at + interval '1 millisecond', expires_at = clock_timestamp() - interval '25 hours' WHERE cache_key = 's2:prune'");
    const cold = await cache(context);
    assert.equal(await cold.get(`s2:pool:v1:${id}`), undefined);
    assert.deepEqual(await cold.get(`s2:pool:v1:${id}`, true), original);
    assert.equal(await cold.get('s2:prune', true), undefined);
    const provider = new SemanticScholarProvider({ cache: cold, fetch: async () => new Response('', { status: 429 }) });
    const service = new SemanticService(cold, false, provider);
    const graph = await service.graph([id]);
    assert.match(graph.meta.warning!, /stale\/local/);
    assert.equal(graph.meta.fetchedAt, meta.fetchedAt);
    assert.equal((await cold.get(`s2:pool:v1:${id}`, true))!.expiresAt, original!.expiresAt);
    assert.equal((await sql!.query("SELECT count(*)::int AS count FROM openpapers.semantic_cache WHERE cache_key = 's2:prune'")).rows[0].count, 0);
    const failed = await cache(context);
    await assert.rejects(new SemanticScholarProvider({ cache: failed, fetch: async () => new Response('', { status: 429 }) }).getPaper(`S2:${sha(9)}`), { status: 429 });
    assert.equal((await sql!.query('SELECT count(*)::int AS count FROM openpapers.semantic_cache WHERE cache_key LIKE $1', [`%${sha(9)}%`])).rows[0].count, 0);
  });
  await t.test('partial successful acquisition persists with its short TTL and native pools hydrate without renewal', async context => {
    await sql!.query('TRUNCATE openpapers.semantic_cache');
    const first = await cache(context);
    let calls = 0;
    const provider = new SemanticScholarProvider({ cache: first, fetch: async () => {
      calls++;
      return calls === 1 ? Response.json(raw.data) : new Response('', { status: 429, headers: { 'Retry-After': '60' } });
    } });
    const graph = await new SemanticService(first, false, provider).graph([id]);
    assert.equal(calls, 2);
    assert.match(graph.meta.warning!, /Partial Semantic Scholar acquisition/);
    const partial = await first.get(`s2:pool:v1:${id}`);
    assert.ok(partial!.expiresAt <= Date.now() + 60000);
    const cold = await cache(context);
    const restartedProvider = new SemanticScholarProvider({ cache: cold, fetch: async () => {
      calls++; return new Response('', { status: 429 });
    } });
    const recovered = await new SemanticService(cold, false, restartedProvider).graph([id]);
    assert.equal(calls, 2);
    assert.equal(recovered.meta.fetchedAt, graph.meta.fetchedAt);
    assert.match(recovered.meta.warning!, /Partial Semantic Scholar acquisition/);
    assert.deepEqual(await cold.get(`s2:pool:v1:${id}`), partial);
  });
  await t.test('old file-only keys stay local and invalid normalized provider data cannot hydrate S2', async context => {
    await sql!.query('TRUNCATE openpapers.semantic_cache');
    const first = await cache(context);
    await first.set('legacy:openalex:W1', { title: 'Old file cache' });
    assert.equal((await sql!.query('SELECT count(*)::int AS count FROM openpapers.semantic_cache')).rows[0].count, 0);
    await first.set(`s2:pool:v1:${id}`, { ...poolValue, provider: 'openalex' });
    await first.set(`s2:paper:v1:${id}`, { paper, meta: { ...meta, provider: 'openalex' } });
    const cold = await cache(context);
    const service = new SemanticService(cold, true);
    await service.ready;
    await assert.rejects(service.paper(id), { status: 503 });
    await assert.rejects(service.graph([id]), { status: 503 });
    assert.equal(await cold.get('legacy:openalex:W1'), undefined);
  });
  await t.test('real blocked SQL has a five-second deadline and cannot lose the valid local envelope', async context => {
    await sql!.query('TRUNCATE openpapers.semantic_cache');
    const first = await cache(context), logs: unknown[][] = [];
    context.mock.method(console, 'warn', (...args: unknown[]) => { logs.push(args); });
    const blocker = await sql!.connect();
    try {
      await blocker.query('SELECT pg_advisory_lock(764521340004)');
      const start = performance.now();
      await first.set('s2:blocked', raw, -1);
      const elapsed = performance.now() - start;
      assert.ok(elapsed >= 4500 && elapsed < 6500, `Database deadline took ${elapsed}ms`);
      const original = await PersistentCache.prototype.get.call(first, 's2:blocked', true);
      assert.equal((await sql!.query("SELECT 1 FROM openpapers.semantic_cache WHERE cache_key = 's2:blocked'")).rows.length, 0);
      assert.deepEqual(await first.get('s2:blocked', true), original);
      assert.equal(await first.get('s2:blocked'), undefined);
      assert.ok(logs.length > 0);
      assert.doesNotMatch(JSON.stringify(logs), /postgresql:|dummy-semantic|password|secret/);
    } finally {
      await blocker.query('SELECT pg_advisory_unlock_all()'); blocker.release();
    }
    await first.set('s2:after-timeout', raw);
    assert.ok(await (await cache(context)).get('s2:after-timeout'), 'A new connection works after the deadline');
  });
  await t.test('concurrent writers enforce count/byte caps, no get refresh, monotonic upserts and private constraints', async context => {
    await sql!.query('TRUNCATE openpapers.semantic_cache');
    const a = await cache(context), b = await cache(context);
    await Promise.all(Array.from({ length: 140 }, (_, i) => (i % 2 ? a : b).set(`s2:bounded:${i}`, raw)));
    const stats = async () => (await sql!.query('SELECT count(*)::int AS count, sum(byte_count)::int AS bytes FROM openpapers.semantic_cache')).rows[0];
    assert.equal((await stats()).count, 128);
    const latest = (await sql!.query('SELECT cache_key, stored_at FROM openpapers.semantic_cache ORDER BY stored_at DESC LIMIT 1')).rows[0];
    await (await cache(context)).get(latest.cache_key);
    assert.equal((await sql!.query('SELECT stored_at FROM openpapers.semantic_cache WHERE cache_key = $1', [latest.cache_key])).rows[0].stored_at.getTime(), latest.stored_at.getTime());
    const previous = await a.get(latest.cache_key, true);
    await sql!.query(`INSERT INTO openpapers.semantic_cache SELECT key_hash, cache_key, stored_at - interval '1 hour',
      expires_at, payload, byte_count FROM openpapers.semantic_cache WHERE cache_key = $1
      ON CONFLICT (key_hash) DO UPDATE SET stored_at = EXCLUDED.stored_at, payload = EXCLUDED.payload`, [latest.cache_key]);
    assert.equal((await b.get(latest.cache_key, true))!.storedAt, previous!.storedAt);
    const big = { text: 'x'.repeat(3 * 1024 * 1024) };
    await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).set(`s2:large:${i}`, big)));
    assert.ok((await stats()).bytes <= 32 * 1024 * 1024);
    assert.ok((await stats()).count <= 128);
    assert.ok(Buffer.byteLength(JSON.stringify(await (await cache(context)).list('s2:'))) <= 32 * 1024 * 1024);
    const oversized = { text: 'x'.repeat(5 * 1024 * 1024) };
    await a.set('s2:oversized', oversized);
    assert.deepEqual((await a.get('s2:oversized'))!.value, oversized);
    assert.equal((await sql!.query("SELECT 1 FROM openpapers.semantic_cache WHERE cache_key = 's2:oversized'")).rows.length, 0);
    const privateTable = (await sql!.query(`SELECT relrowsecurity, pg_get_userbyid(relowner) AS owner
      FROM pg_class WHERE oid = 'openpapers.semantic_cache'::regclass`)).rows[0];
    assert.deepEqual(privateTable, { relrowsecurity: true, owner: 'postgres' });
    for (const role of ['anon', 'authenticated', 'service_role']) {
      if ((await sql!.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rows.length) {
        assert.equal((await sql!.query("SELECT has_table_privilege($1, 'openpapers.semantic_cache', 'SELECT') AS access", [role])).rows[0].access, false);
      }
    }
    await assert.rejects(sql!.query(`INSERT INTO openpapers.semantic_cache VALUES ($1, 'oa:cross-provider',
      clock_timestamp(), clock_timestamp(), '{"version":1,"value":{}}', 1)`, ['a'.repeat(64)]), { code: '23514' });
  });
});

test('migration runner appends the CLI-generated private cache migration without graph marker changes', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20261019105844_semantic_cache.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS openpapers\.semantic_cache/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /SECURITY INVOKER/);
  assert.match(sql, /pg_advisory_xact_lock\(764521340004\)/);
  assert.match(sql, /retained_count >= 128/); assert.match(sql, /33554432/); assert.match(sql, /4194304/);
  assert.doesNotMatch(sql, /\b(?:DROP|GRANT|CREATE POLICY)\b|schema_migrations|api_key/i);
  const runner = await readFile(new URL('../scripts/migrate-graph-jobs.ts', import.meta.url), 'utf8');
  assert.equal(runner.split('20261019105844_semantic_cache.sql').length - 1, 1);
  assert.match(runner, /await client\.query\(sql\); await client\.query\(semanticSql\); await client\.query\(semanticCacheSql\)/);
});
