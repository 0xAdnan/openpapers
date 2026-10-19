import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import pg, { type PoolConfig } from 'pg';
import { PersistentCache } from './cache.ts';
import { createSemanticRateLimiter, GlobalS2RateLimiter, semanticRetryAfter, SemanticRateLimitError,
  S2_PACING_MS, type SemanticRateReservation } from './semantic-rate-limit.ts';
import { SemanticScholarError, SemanticScholarProvider } from './semantic-scholar.ts';

const hash = (key: string) => createHash('sha256').update(key).digest('hex');
const sha = (n: number) => n.toString(16).padStart(40, '0');
const signal = () => AbortSignal.timeout(10000);
const fixtures: typeof fetch = async () => Response.json({ paperId: sha(1), title: 'Fixture' });

async function cache(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'semantic-rate-limit-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return new PersistentCache(directory);
}

test('same API key shares serialization across providers, caches, search and batch, with 1250ms pacing', async t => {
  const apiKey = randomUUID(), starts: number[] = [];
  let active = 0, maximum = 0;
  const transport: typeof fetch = async input => {
    starts.push(Date.now()); active++; maximum = Math.max(maximum, active);
    await delay(15); active--;
    return String(input).includes('/search') ? Response.json({ total: 0, offset: 0, data: [] })
      : Response.json([{ paperId: sha(1), title: 'Fixture' }]);
  };
  const first = new SemanticScholarProvider({ apiKey, cache: await cache(t), fetch: transport });
  const second = new SemanticScholarProvider({ apiKey, cache: await cache(t), fetch: transport });
  await Promise.all([first.search('fixture', 1), second.batch([`S2:${sha(1)}`])]);
  assert.equal(starts.length, 2);
  assert.equal(maximum, 1);
  assert.ok(starts[1] - starts[0] >= S2_PACING_MS);
});

test('different API keys do not serialize each other', async () => {
  const first = createSemanticRateLimiter({ apiKey: randomUUID(), fetch: fixtures });
  const second = createSemanticRateLimiter({ apiKey: randomUUID(), fetch: fixtures });
  const start = Date.now();
  const [a, b] = await Promise.all([first.reserve(signal()), second.reserve(signal())]);
  assert.ok(Date.now() - start < 500);
  await Promise.all([a.release(), b.release()]);
});

test('429 cooldown is shared with another provider instance and all endpoints without retry', async t => {
  for (const header of ['1', '120', new Date(Date.now() + 180000).toUTCString(), 'invalid']) {
    const apiKey = randomUUID();
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': header } }); };
    const first = new SemanticScholarProvider({ apiKey, cache: await cache(t), fetch });
    const second = new SemanticScholarProvider({ apiKey, cache: await cache(t), fetch });
    const results = await Promise.allSettled([first.getPaper(`S2:${sha(1)}`), second.references(`S2:${sha(2)}`)]);
    assert.equal(calls, 1);
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') {
        assert.ok(result.reason instanceof SemanticScholarError);
        assert.equal(result.reason.status, 429);
        assert.ok((result.reason.retryAfter ?? 0) >= (header === '120' ? 119 : 59));
      }
    }
    await assert.rejects(second.citations(`S2:${sha(3)}`), { status: 429 });
    assert.equal(calls, 1);
  }
});

test('Retry-After is safe for malformed, numeric overflow, decimal, past and far-future values', () => {
  const now = Date.now();
  for (const value of [null, 'invalid', '-5', '1e999', 'NaN', 'Infinity', new Date(now - 1000).toUTCString()]) {
    assert.equal(semanticRetryAfter(value, now), 60);
  }
  assert.equal(semanticRetryAfter('120.1', now), 121);
  assert.equal(semanticRetryAfter('9'.repeat(1000), now), 86400);
  assert.equal(semanticRetryAfter(new Date(now + 10 * 86400000).toUTCString(), now), 86400);
});

test('shared per-key queue is bounded to 16 and abort removes queued waiters', async () => {
  const apiKey = randomUUID();
  const gates = Array.from({ length: 18 }, () => createSemanticRateLimiter({ apiKey, fetch: fixtures }));
  const active = await gates[0].reserve(signal());
  const controllers = Array.from({ length: 16 }, () => new AbortController());
  const waiting = controllers.map((controller, i) => assert.rejects(gates[i + 1].reserve(controller.signal), /cancelled/));
  await assert.rejects(gates[17].reserve(signal()), { status: 503, message: 'Semantic Scholar request queue is full' });
  for (const controller of controllers) controller.abort(new Error('cancelled'));
  await Promise.all(waiting);
  await active.release();
  const next = await gates[17].reserve(signal());
  next.assertValid();
  await next.release();
});

test('pacing cancellation does not consume future slots; elapsed time cannot accumulate bursts', async () => {
  const gate = new GlobalS2RateLimiter();
  const first = await gate.reserve(signal());
  await delay(1400);
  const releasedAt = Date.now();
  await first.release();
  await assert.rejects(gate.reserve(AbortSignal.timeout(20)));
  const next = await gate.reserve(signal());
  assert.ok(Date.now() - releasedAt >= S2_PACING_MS);
  await next.release();
  await assert.rejects(gate.reserve(AbortSignal.timeout(20)));
});

test('aborting transport cannot release the shared gate before transport settles', async t => {
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const apiKey = randomUUID();
  let entered!: () => void, settle!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { settle = resolve; });
  const first = new SemanticScholarProvider({ apiKey, cache: await cache(t), fetch: async () => {
    calls++; entered(); await blocked; return Response.json({ paperId: sha(1), title: 'Fixture' });
  } });
  const second = new SemanticScholarProvider({ apiKey, cache: await cache(t), timeoutMs: 60,
    fetch: async () => { calls++; return Response.json({ paperId: sha(2), title: 'Fixture' }); } });
  const controller = new AbortController();
  const request = assert.rejects(first.getPaper(`S2:${sha(1)}`, controller.signal));
  await started; controller.abort();
  await assert.rejects(second.getPaper(`S2:${sha(2)}`), { status: 503 });
  assert.equal(calls, 1);
  settle(); await request;
});

test('body consumption remains inside the shared reservation', async t => {
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const apiKey = randomUUID();
  let entered!: () => void, close!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const first = new SemanticScholarProvider({ apiKey, cache: await cache(t), fetch: async () => {
    calls++;
    return new Response(new ReadableStream({ start(controller) {
      entered(); close = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ paperId: sha(1), title: 'Fixture' }))); controller.close(); };
    } }));
  } });
  const second = new SemanticScholarProvider({ apiKey, cache: await cache(t), timeoutMs: 40,
    fetch: async () => { calls++; return Response.json({ paperId: sha(2), title: 'Fixture' }); } });
  const request = first.getPaper(`S2:${sha(1)}`);
  await started;
  await assert.rejects(second.getPaper(`S2:${sha(2)}`), { status: 503 });
  assert.equal(calls, 1);
  close(); await request;
});

test('migration and runner are additive, private, repeatable, and leave the graph migration marker alone', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20261019093612_semantic_api_budget.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS openpapers\.semantic_api_budget/);
  assert.match(sql, /key_hash text PRIMARY KEY CHECK \(key_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(sql, /OWNER TO postgres/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON TABLE openpapers\.semantic_api_budget FROM PUBLIC/);
  assert.match(sql, /'anon', 'authenticated', 'service_role'/);
  assert.match(sql, /pg_advisory_xact_lock\(764521340001\)/);
  assert.doesNotMatch(sql, /\b(?:DROP|GRANT|CREATE POLICY)\b|schema_migrations|api_key/i);
  const runner = await readFile(new URL('../scripts/migrate-graph-jobs.ts', import.meta.url), 'utf8');
  assert.equal(runner.split('20261019093612_semantic_api_budget.sql').length - 1, 1);
});

test('database leases use a single verified-TLS pool, DB clock, token fencing and bounded transactions', async t => {
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  // Fake only the PG transport. No environment files, DB connections or migrations are used.
  type Row = { token: string | null; leaseUntil: number; next: number; cooldown: number };
  const rows = new Map<string, Row>();
  const queries: { text: string; values: unknown[] }[] = [];
  const configs: PoolConfig[] = [];
  let connections = 0, activeConnections = 0, maximum = 0, failure = false, clock = Date.now();
  const pool = {
    on() {},
    connect(callback: (error: Error | null, client?: unknown, release?: (destroy?: boolean) => void) => void) {
      connections++; activeConnections++; maximum = Math.max(maximum, activeConnections);
      let released = false;
      const release = () => { if (!released) { released = true; activeConnections--; } };
      const client = { release, async query(text: string, values: unknown[] = []) {
        queries.push({ text, values });
        if (failure) throw new Error('private database credentials must not escape');
        if (text === 'BEGIN' || text === 'COMMIT') return { rows: [], rowCount: 0 };
        const key = String(values[0]);
        if (text.startsWith('INSERT')) {
          if (!rows.has(key)) rows.set(key, { token: null, leaseUntil: 0, next: clock, cooldown: 0 });
          return { rows: [], rowCount: 0 };
        }
        const row = rows.get(key)!;
        if (text.startsWith('UPDATE') && text.includes('SET leased_slot_token = $2')) {
          if (Math.max(row.next, row.cooldown, row.leaseUntil) > clock) return { rows: [], rowCount: 0 };
          row.token = String(values[1]); row.leaseUntil = clock + Number(values[2]); row.next = clock + Number(values[3]);
          return { rows: [{ lease_ms: Number(values[2]) }], rowCount: 1 };
        }
        if (text.startsWith('UPDATE') && text.includes('SET cooldown_until')) {
          if (row.token !== values[1]) return { rows: [], rowCount: 0 };
          row.cooldown = Math.max(row.cooldown, clock + Number(values[2]) * 1000);
          return { rows: [], rowCount: 1 };
        }
        if (text.startsWith('UPDATE')) {
          if (row.token !== values[1]) return { rows: [], rowCount: 0 };
          row.token = null; row.leaseUntil = 0; row.next = clock + Number(values[2]); row.cooldown = Math.max(row.cooldown, clock + Number(values[3]) * 1000);
          return { rows: [], rowCount: 1 };
        }
        return { rows: [{ cooldown_ms: Math.max(0, row.cooldown - clock), wait_ms: Math.max(0, row.next - clock, row.leaseUntil - clock) }], rowCount: 1 };
      } };
      callback(null, client, release);
    },
  };
  t.mock.method(pg, 'Pool', function (config: PoolConfig) { configs.push(config); return pool; });
  const databaseUrl = 'postgresql://postgres:dummy@database.example/test?sslmode=verify-full';
  const gate = () => new GlobalS2RateLimiter({ keyHash: hash(randomUUID()), databaseUrl });

  await t.test('lazy startup and no schema creation; at most 5-second DB operations', async () => {
    const limiter = gate(); assert.equal(configs.length, 0);
    const reservation = await limiter.reserve(signal());
    assert.equal(activeConnections, 0, 'No DB connection or transaction held through fetch');
    assert.equal(configs.length, 1); assert.equal(configs[0].max, 1);
    assert.deepEqual(configs[0].ssl, { rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    for (const key of ['connectionTimeoutMillis', 'query_timeout', 'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout'] as const) {
      assert.equal(configs[0][key], 5000);
    }
    reservation.assertValid();
    await reservation.release();
    assert.equal(activeConnections, 0);
    assert.doesNotMatch(queries.map(q => q.text).join('\n'), /CREATE|ALTER/);
  });

  await t.test('release uses server completion + 1250ms and persists shared 429 cooldown', async () => {
    const limiter = gate();
    const reservation = await limiter.reserve(signal());
    const key = [...rows.keys()].at(-1)!;
    clock += 2000;
    await reservation.release(120);
    assert.equal(rows.get(key)!.next, clock + S2_PACING_MS);
    assert.equal(rows.get(key)!.cooldown, clock + 120000);
    const otherInstance = new GlobalS2RateLimiter({ keyHash: key, databaseUrl });
    await assert.rejects(otherInstance.reserve(signal()), { status: 429 });
    assert.equal(configs.length, 1);
  });

  await t.test('a delayed reservation cannot fetch after its database lease expires', async context => {
    let elapsed = 0;
    context.mock.method(performance, 'now', () => elapsed);
    const reservation = await gate().reserve(signal());
    reservation.assertValid();
    elapsed = 18000;
    assert.throws(() => reservation.assertValid(), { status: 503 });
    await reservation.release();
  });

  await t.test('busy lease polls at least 500ms and obeys cancellation, without catching up slots', async () => {
    const key = hash(randomUUID());
    rows.set(key, { token: randomUUID(), leaseUntil: clock + 30000, next: clock + 31250, cooldown: 0 });
    const limiter = new GlobalS2RateLimiter({ keyHash: key, databaseUrl });
    const before = connections;
    await assert.rejects(limiter.reserve(AbortSignal.timeout(40)));
    assert.equal(connections - before, 1);
    assert.equal(activeConnections, 0);
  });

  await t.test('release is fenced against another instance replacing an expired lease', async () => {
    const reservation = await gate().reserve(signal());
    const row = rows.get([...rows.keys()].at(-1)!)!;
    row.token = randomUUID();
    await assert.rejects(reservation.release(), { status: 503 });
    assert.notEqual(row.token, null);
    await reservation.release();
    assert.throws(() => reservation.assertValid(), { status: 503 });
  });

  await t.test('missing migration, privilege or DB errors fail closed without exposing credentials', async () => {
    failure = true;
    await assert.rejects(gate().reserve(signal()), { status: 503, message: 'Semantic Scholar shared rate gate is unavailable' });
    failure = false;
    assert.equal(activeConnections, 0);
  });

  await t.test('consumer abort still permits deadline-bounded database cleanup', async () => {
    const controller = new AbortController();
    const reservation = await gate().reserve(controller.signal);
    controller.abort();
    await reservation.release(120);
    assert.equal(rows.get([...rows.keys()].at(-1)!)!.token, null);
  });
  await t.test('429 persists before release; failed cleanup leaves the cooldown and lease intact', async () => {
    const reservation = await gate().reserve(signal());
    const row = rows.get([...rows.keys()].at(-1)!)!;
    await reservation.cooldown!(120, signal());
    assert.equal(row.cooldown, clock + 120000);
    assert.notEqual(row.token, null);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(reservation.release(120, controller.signal), { status: 503 });
    assert.equal(row.cooldown, clock + 120000);
    assert.notEqual(row.token, null);
  });
  await t.test('provider makes no external calls when the database gate is unavailable', async context => {
    let fetched = 0;
    context.mock.method(globalThis, 'fetch', async () => { fetched++; return Response.json({ paperId: sha(1), title: 'Fixture' }); });
    const provider = new SemanticScholarProvider({ apiKey: randomUUID(), databaseUrl, cache: await cache(context) });
    failure = true;
    try { await assert.rejects(provider.getPaper(`S2:${sha(1)}`), { status: 503 }); }
    finally { failure = false; }
    assert.equal(fetched, 0);
  });
  assert.equal(maximum, 1);
  for (const query of queries.filter(query => query.values.length)) assert.match(String(query.values[0]), /^[0-9a-f]{64}$/);
});

test('Vercel without a database fails closed; fixture and offline gates do not consult DATABASE_URL', async t => {
  const before = process.env.VERCEL;
  process.env.VERCEL = '1';
  t.after(() => { if (before === undefined) delete process.env.VERCEL; else process.env.VERCEL = before; });
  const unavailable = createSemanticRateLimiter({ apiKey: randomUUID(), databaseUrl: '' });
  await assert.rejects(unavailable.reserve(signal()), { status: 503 });
  for (const options of [{ fetch: fixtures }, { offline: true }]) {
    const reservation = await createSemanticRateLimiter({ apiKey: randomUUID(), databaseUrl: 'invalid', ...options }).reserve(signal());
    await reservation.release();
  }
  let fetched = 0;
  t.mock.method(globalThis, 'fetch', async () => { fetched++; return Response.json({ paperId: sha(1), title: 'Fixture' }); });
  const provider = new SemanticScholarProvider({ cache: await cache(t), apiKey: randomUUID(), databaseUrl: '' });
  await assert.rejects(provider.getPaper(`S2:${sha(1)}`), { status: 503 });
  assert.equal(fetched, 0);
  const offline = new SemanticScholarProvider({ cache: await cache(t), apiKey: randomUUID(), offline: true, databaseUrl: 'invalid' });
  await assert.rejects(offline.getPaper(`S2:${sha(1)}`), { status: 503 });
  assert.equal(fetched, 0);
});

test('constructor injection reserves before fetch, records cooldown and releases exactly once', async t => {
  const events: string[] = [];
  const provider = new SemanticScholarProvider({ cache: await cache(t), rateLimiter: {
    async reserve(signal) {
      signal.throwIfAborted(); events.push('reserve');
      return { assertValid() { events.push('valid'); }, async release(retryAfter) { events.push(`release:${retryAfter}`); } };
    },
  }, fetch: async () => { events.push('fetch'); return new Response('', { status: 429, headers: { 'Retry-After': '120' } }); } });
  await assert.rejects(provider.getPaper(`S2:${sha(1)}`), { status: 429, retryAfter: 120 });
  assert.deepEqual(events, ['reserve', 'valid', 'fetch', 'release:120']);
});

test('key map never evicts active or cooling keys and is bounded to 100 hashes', async () => {
  const held: SemanticRateReservation[] = [];
  // Earlier test keys are expired and evictable except their four active cooldowns.
  for (let i = 0; i < 101; i++) {
    const gate = createSemanticRateLimiter({ apiKey: randomUUID(), fetch: fixtures });
    try { held.push(await gate.reserve(signal())); }
    catch (error) {
      assert.ok(error instanceof SemanticRateLimitError);
      assert.equal(error.status, 503);
      break;
    }
  }
  assert.ok(held.length <= 100 && held.length >= 80, `Unexpected key capacity: ${held.length}`);
  await assert.rejects(createSemanticRateLimiter({ apiKey: randomUUID(), fetch: fixtures }).reserve(signal()), { status: 503 });
  await Promise.all(held.map(reservation => reservation.release()));
  await delay(S2_PACING_MS);
  const replacement = await createSemanticRateLimiter({ apiKey: randomUUID(), fetch: fixtures }).reserve(signal());
  await replacement.release();
});
