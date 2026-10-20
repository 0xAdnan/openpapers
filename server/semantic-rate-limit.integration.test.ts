import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, describe, test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type pg from 'pg';

type Event = { event: string; pid: number; at: number; utc: string; hrtime: string;
  keyHash: string; fetches?: number; status?: number; message?: string; phase?: string };
const hash = (key: string) => createHash('sha256').update(key).digest('hex');

// Run this file as a temporary worker to avoid a second fixture implementation.
// Workers import the exact production class by URL.
if (process.argv[2] === '--s2-worker') {
  const [, , , moduleUrl, databaseUrl, dummyKey, mode] = process.argv;
  const { GlobalS2RateLimiter } = await import(moduleUrl);
  const keyHash = hash(dummyKey);
  const limiter = new GlobalS2RateLimiter({ keyHash, databaseUrl });
  const controller = new AbortController();
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const input = createInterface({ input: process.stdin });
  const send = (event: string, extra: Partial<Event> = {}) => {
    const at = Date.now();
    process.stdout.write(JSON.stringify({ event, pid: process.pid, at, utc: new Date(at).toISOString(),
      hrtime: process.hrtime.bigint().toString(), keyHash, ...extra }) + '\n');
  };
  globalThis.fetch = async () => { throw new Error('Integration workers must never make API requests'); };
  let started = false;
  input.on('line', line => {
    const { command } = JSON.parse(line);
    if (command === 'abort') controller.abort(new Error('Queued request aborted'));
    if (command === 'release') release();
    if (command !== 'reserve' || started) return;
    started = true;
    void (async () => {
      let fetches = 0, phase = 'reserve';
      try {
        const lease = await limiter.reserve(AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]));
        lease.assertValid();
        phase = 'fetch'; fetches++;
        send('fetch-start');
        await delay(250);
        send('fetch-complete');
        if (mode === 'cooldown') {
          phase = 'cooldown';
          await lease.cooldown(120, AbortSignal.timeout(5000));
          send('cooldown');
        }
        if (mode === 'hold' || mode === 'cooldown') await released;
        phase = 'release';
        await lease.release();
        send('result', { fetches, phase });
      } catch (error) {
        const failure = error as Error & { status?: number };
        send('result', { fetches, phase, status: failure.status, message: failure.message });
      } finally {
        input.close(); process.stdin.destroy();
      }
    })();
  });
  send('ready');
} else {
  describe('PostgreSQL Semantic Scholar cross-process gate',
    { skip: !process.env.GRAPH_TEST_DATABASE_URL, timeout: 90000, concurrency: true }, () => {
      let admin: pg.Pool | undefined, sql: pg.Pool, databaseUrl: string;
      let ownedDatabase = false, cleaningUp = false, directory: string | undefined, workerPath: string;
      const databaseName = `s2_integration_${randomUUID().replaceAll('-', '')}`;
      const children = new Set<ReturnType<typeof spawn>>();

      before(async () => {
        const root = new URL(process.env.GRAPH_TEST_DATABASE_URL!);
        assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(root.hostname),
          'GRAPH_TEST_DATABASE_URL must explicitly identify local disposable PostgreSQL, never Supabase');
        const { default: pg } = await import('pg');
        const { graphPostgresPoolConfig } = await import('./postgres-store.ts');
        const { migrateGraphJobs } = await import('../scripts/migrate-graph-jobs.ts');
        admin = new pg.Pool(graphPostgresPoolConfig(root.href, { max: 1 }));
        const preflight = await admin.query(`SELECT current_setting('server_version_num')::integer AS version,
          current_user AS owner, rolcreatedb OR rolsuper AS can_create FROM pg_roles WHERE rolname = current_user`);
        assert.equal(preflight.rows[0].owner, 'postgres');
        assert.equal(preflight.rows[0].can_create, true, 'Local test user needs CREATEDB');
        assert.ok(preflight.rows[0].version >= 160000 && preflight.rows[0].version < 170000, 'Use PostgreSQL 16');
        await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
        ownedDatabase = true;
        root.pathname = `/${databaseName}`;
        databaseUrl = root.href;
        sql = new pg.Pool(graphPostgresPoolConfig(databaseUrl, { max: 2 }));
        sql.on('error', error => { assert.ok(cleaningUp, `Unexpected test pool error: ${error.message}`); });
        await migrateGraphJobs(databaseUrl);
        await migrateGraphJobs(databaseUrl);
        assert.equal((await sql.query(`SELECT count(*)::integer AS count FROM pg_tables
          WHERE schemaname = 'openpapers'`)).rows[0].count, 8);
        assert.equal((await sql.query('SELECT count(*)::integer AS count FROM openpapers.schema_migrations')).rows[0].count, 1);
        directory = await mkdtemp(join(tmpdir(), 's2-postgres-workers-'));
        workerPath = join(directory, 'worker.mts');
        await copyFile(new URL(import.meta.url), workerPath);
      });

      after(async () => {
        cleaningUp = true;
        try {
          for (const child of children) child.kill('SIGKILL');
          await sql?.end();
        } finally {
          try {
            if (ownedDatabase) await admin!.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
          } finally {
            await admin?.end();
            if (directory) await rm(directory, { recursive: true, force: true });
          }
        }
      });

      function worker(t: TestContext, dummyKey: string, mode = 'auto') {
        const child = spawn(process.execPath, ['--import', 'tsx', workerPath, '--s2-worker',
          new URL('./semantic-rate-limit.ts', import.meta.url).href, databaseUrl, dummyKey, mode],
        { cwd: new URL('..', import.meta.url), env: { PATH: process.env.PATH, NODE_ENV: 'test' }, stdio: ['pipe', 'pipe', 'pipe'] });
        children.add(child);
        const events: Event[] = [];
        let stderr = '', failure: Error | undefined;
        const pending = new Set<() => void>();
        const notify = () => { for (const check of pending) check(); };
        const output = createInterface({ input: child.stdout });
        output.on('line', line => {
          try { events.push(JSON.parse(line)); }
          catch { failure = new Error(`Worker emitted invalid JSON: ${line}`); }
          notify();
        });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', error => { failure = error; notify(); });
        const closed = new Promise<void>(resolve => child.once('close', code => {
          children.delete(child);
          if (code !== 0) failure = new Error(`Worker exited ${code}: ${stderr}`);
          notify(); resolve();
        }));
        t.after(async () => { child.kill('SIGKILL'); await closed; output.close(); });
        const wait = (event: string) => new Promise<Event>((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(check); reject(new Error(`Worker timed out waiting for ${event}: ${stderr}`)); }, 10000);
          const check = () => {
            const found = events.find(value => value.event === event);
            if (!found && !failure) return;
            clearTimeout(timer); pending.delete(check);
            if (failure) reject(failure); else resolve(found!);
          };
          pending.add(check); check();
        });
        return { events, wait, closed, command: (command: string) => child.stdin.write(JSON.stringify({ command }) + '\n') };
      }

      async function row(keyHash: string) {
        return (await sql.query(`SELECT *, clock_timestamp() AS db_now FROM openpapers.semantic_api_budget WHERE key_hash = $1`, [keyHash])).rows[0];
      }

      function noFetch(events: Event[], result: Event) {
        assert.equal(result.fetches, 0);
        assert.equal(events.some(event => event.event === 'fetch-start'), false);
      }

      test('same hash in independent processes serializes fetches and paces from actual completion', async t => {
        const dummyKey = `dummy-s2-${randomUUID()}`;
        const first = worker(t, dummyKey), second = worker(t, dummyKey);
        const [a, b] = await Promise.all([first.wait('ready'), second.wait('ready')]);
        assert.notEqual(a.pid, b.pid); assert.notEqual(a.pid, process.pid); assert.notEqual(b.pid, process.pid);
        assert.equal(a.keyHash, b.keyHash); assert.equal(a.keyHash, hash(dummyKey));
        first.command('reserve');
        const start = await first.wait('fetch-start');
        const claimed = await row(a.keyHash);
        assert.ok(claimed.leased_slot_token);
        assert.ok(claimed.lease_until.getTime() - claimed.db_now.getTime() > 29000);
        second.command('reserve');
        const completion = await first.wait('fetch-complete');
        const next = await second.wait('fetch-start');
        assert.ok(completion.at - start.at >= 240, 'Simulated fetch must really take 250ms');
        assert.ok(next.at - completion.at >= 1100, `Completion-to-next-start gap was ${next.at - completion.at}ms (1250ms pacing, 150ms clock tolerance)`);
        assert.ok(Number(BigInt(next.hrtime) - BigInt(completion.hrtime)) / 1e6 >= 1100);
        assert.ok(next.at - start.at >= 1250, 'Provider must remain strictly below 1 request/second');
        for (const event of [start, completion, next]) assert.equal(Date.parse(event.utc), event.at);
        const results = await Promise.all([first.wait('result'), second.wait('result')]);
        for (const result of results) { assert.equal(result.fetches, 1); assert.equal(result.status, undefined); }
        await Promise.all([first.closed, second.closed]);
        assert.equal((await row(a.keyHash)).leased_slot_token, null);
        t.diagnostic(`Independent PIDs ${a.pid}/${b.pid}; completion-to-next-start ${next.at - completion.at}ms.`);
      });

      test('aborting a database-queued process never starts its fetch or changes the active lease', async t => {
        const dummyKey = `dummy-s2-${randomUUID()}`, keyHash = hash(dummyKey);
        // Count committed attempts for this key only; other concurrent tests must
        // not satisfy the observation that this worker reached the busy DB row.
        await sql.query(`CREATE TABLE openpapers.test_queue_probe (attempts integer NOT NULL);
          INSERT INTO openpapers.test_queue_probe VALUES (0);
          CREATE FUNCTION openpapers.observe_test_queue() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN IF NEW.key_hash = '${keyHash}' THEN UPDATE openpapers.test_queue_probe SET attempts = attempts + 1; END IF;
            RETURN NEW; END $$;
          CREATE TRIGGER observe_test_queue BEFORE INSERT ON openpapers.semantic_api_budget
          FOR EACH ROW EXECUTE FUNCTION openpapers.observe_test_queue()`);
        const owner = worker(t, dummyKey, 'hold'), queued = worker(t, dummyKey);
        await Promise.all([owner.wait('ready'), queued.wait('ready')]);
        owner.command('reserve'); await owner.wait('fetch-start');
        const original = await row(keyHash);
        queued.command('reserve');
        // Observe a real completed busy-row transaction, not merely worker startup.
        for (let i = 0; ; i++) {
          const seen = await sql.query('SELECT attempts FROM openpapers.test_queue_probe');
          if (seen.rows[0].attempts >= 2) break;
          assert.ok(i < 100, 'Queued worker did not consult PostgreSQL'); await delay(10);
        }
        queued.command('abort');
        const result = await queued.wait('result');
        noFetch(queued.events, result); assert.equal(result.message, 'Queued request aborted');
        const unchanged = await row(keyHash);
        assert.equal(unchanged.leased_slot_token, original.leased_slot_token);
        assert.equal(unchanged.next_request_at.getTime(), original.next_request_at.getTime());
        await owner.wait('fetch-complete'); owner.command('release');
        assert.equal((await owner.wait('result')).status, undefined);
        await Promise.all([owner.closed, queued.closed]);
      });

      test('429 cooldown persists before release and rejects another process without storing the raw key', async t => {
        const dummyKey = `dummy-s2-secret-${randomUUID()}`, keyHash = hash(dummyKey);
        const owner = worker(t, dummyKey, 'cooldown'), other = worker(t, dummyKey);
        await Promise.all([owner.wait('ready'), other.wait('ready')]);
        owner.command('reserve'); await owner.wait('cooldown');
        const cooling = await row(keyHash);
        assert.ok(cooling.leased_slot_token, 'Cooldown must be durable while the lease is still active');
        assert.ok(cooling.cooldown_until.getTime() - cooling.db_now.getTime() >= 119000);
        owner.command('release'); assert.equal((await owner.wait('result')).status, undefined);
        other.command('reserve');
        const result = await other.wait('result');
        assert.equal(result.status, 429); noFetch(other.events, result);
        const persisted = await row(keyHash);
        assert.equal(persisted.key_hash, keyHash); assert.equal(persisted.leased_slot_token, null);
        assert.ok(persisted.cooldown_until > persisted.db_now);
        assert.ok(!JSON.stringify(persisted).includes(dummyKey));
        assert.ok(!JSON.stringify([...owner.events, ...other.events]).includes(dummyKey));
        const columns = await sql.query(`SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'openpapers' AND table_name = 'semantic_api_budget'`);
        assert.deepEqual(columns.rows.map(value => value.column_name).sort(),
          ['cooldown_until', 'key_hash', 'lease_until', 'leased_slot_token', 'next_request_at']);
        await Promise.all([owner.closed, other.closed]);
      });

      test('token fencing and actual failed COMMITs fail closed and roll back the database row', async t => {
        const dummyKey = `dummy-s2-${randomUUID()}`, keyHash = hash(dummyKey);
        const stale = worker(t, dummyKey, 'hold');
        const failingKey = `dummy-s2-${randomUUID()}`, failingHash = hash(failingKey);
        const claim = worker(t, failingKey), owner = worker(t, failingKey, 'hold'), next = worker(t, failingKey);
        await Promise.all([stale, claim, owner, next].map(child => child.wait('ready')));
        stale.command('reserve'); await stale.wait('fetch-complete');
        const replacement = randomUUID();
        await sql.query(`UPDATE openpapers.semantic_api_budget SET leased_slot_token = $2,
          cooldown_until = clock_timestamp() + interval '60 seconds' WHERE key_hash = $1`, [keyHash, replacement]);
        const fenced = await row(keyHash);
        stale.command('release'); assert.equal((await stale.wait('result')).status, 503);
        const unchanged = await row(keyHash);
        for (const field of ['leased_slot_token', 'lease_until', 'next_request_at', 'cooldown_until']) {
          assert.deepEqual(unchanged[field], fenced[field]);
        }
        await stale.closed;

        const lock = 7321901;
        const blocker = await sql.connect();
        try {
          await blocker.query('SELECT pg_advisory_lock($1)', [lock]);
          // A deferred trigger runs inside real COMMIT, after INSERT/UPDATE has
          // succeeded. Terminating that backend forces PostgreSQL to roll back.
          await sql.query(`CREATE FUNCTION openpapers.block_test_commit() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN IF NEW.key_hash = '${failingHash}' THEN PERFORM pg_advisory_xact_lock(${lock}); END IF;
            RETURN NULL; END $$;
            CREATE CONSTRAINT TRIGGER block_test_commit AFTER INSERT OR UPDATE ON openpapers.semantic_api_budget
            DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION openpapers.block_test_commit()`);
          async function terminateCommit() {
            for (let i = 0; ; i++) {
              const waiting = await sql.query(`SELECT a.pid FROM pg_stat_activity a WHERE a.datname = current_database()
                AND a.application_name = 'openpapers-semantic-budget' AND a.query = 'COMMIT' AND a.wait_event = 'advisory'
                AND EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = a.pid AND l.locktype = 'advisory'
                  AND l.objid = $1 AND NOT l.granted)`, [lock]);
              if (waiting.rows.length) {
                assert.equal(waiting.rows.length, 1);
                assert.equal((await sql.query('SELECT pg_terminate_backend($1) AS killed', [waiting.rows[0].pid])).rows[0].killed, true);
                return;
              }
              assert.ok(i < 200, 'Worker never reached a real blocked COMMIT'); await delay(10);
            }
          }
          claim.command('reserve'); await terminateCommit();
          const failed = await claim.wait('result');
          assert.equal(failed.status, 503); assert.equal(failed.phase, 'reserve'); noFetch(claim.events, failed);
          assert.equal(await row(failingHash), undefined, 'Failed acquisition COMMIT must roll back even the inserted budget row');
          await claim.closed;

          await blocker.query('SELECT pg_advisory_unlock($1)', [lock]);
          owner.command('reserve'); await owner.wait('fetch-complete');
          const original = await row(failingHash);
          await blocker.query('SELECT pg_advisory_lock($1)', [lock]);
          owner.command('release'); await terminateCommit();
          assert.equal((await owner.wait('result')).status, 503);
          const rolledBack = await row(failingHash);
          assert.equal(rolledBack.leased_slot_token, original.leased_slot_token);
          assert.equal(rolledBack.lease_until.getTime(), original.lease_until.getTime());
          assert.equal(rolledBack.next_request_at.getTime(), original.next_request_at.getTime());
          assert.ok(rolledBack.lease_until > rolledBack.db_now, 'Failed release must retain the 30-second lease');
          await owner.closed;
          await blocker.query('SELECT pg_advisory_unlock($1)', [lock]);
          await sql.query('DROP TRIGGER block_test_commit ON openpapers.semantic_api_budget');
          // Keep the surviving lease; use a durable cooldown to prove fail-closed
          // behavior without sleeping through its full 30-second crash recovery.
          await sql.query(`UPDATE openpapers.semantic_api_budget SET cooldown_until = clock_timestamp() + interval '60 seconds'
            WHERE key_hash = $1`, [failingHash]);
          next.command('reserve');
          const rejected = await next.wait('result');
          assert.equal(rejected.status, 429); noFetch(next.events, rejected); await next.closed;
        } finally {
          await blocker.query('SELECT pg_advisory_unlock_all()').catch(() => {});
          blocker.release();
        }
      });
    });
}
