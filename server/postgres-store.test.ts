import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import type { JobCheckpoint, LeasedGraphJob, PageCommit } from '../shared/graph-jobs.ts';
import type { GraphResponse, Paper } from '../shared/types.ts';
import { migrateGraphJobs } from '../scripts/migrate-graph-jobs.ts';
import { graphPostgresPoolConfig, PostgresGraphStore, type PostgresGraphStoreOptions } from './postgres-store.ts';

const checkpoint: JobCheckpoint = { frontier: [], seeded: ['W1'], expanded: [] };
function paper(id = 'W1', references: string[] = []): Paper {
  return { id, references, title: `Paper ${id}`, authors: [], year: null, venue: '', citations: 0,
    abstract: '', doi: null, url: `https://openalex.org/${id}`, pdfUrl: null, openAccess: false, topics: [] };
}
function page(papers: Paper[] = [], extra: Partial<PageCommit> & { providerCooldownUntil?: string | null } = {}): PageCommit {
  return { papers, fetchedAt: new Date().toISOString(), checkpoint, requestUsed: false, ...extra };
}
function graph(origins = ['W1']): GraphResponse {
  return { origins, nodes: origins.map(id => ({ ...paper(id), similarity: 1, sharedReferences: 0, coCitations: 0,
    graphConnections: 0, isOrigin: true })), edges: [], prior: [], derivative: [],
  meta: { source: 'live', provider: 'openalex', fetchedAt: new Date().toISOString(), candidateCount: origins.length,
    algorithm: 'indexed-v2', coverage: 'Test acquired records' } };
}

test('pool configuration verifies remote TLS and bounds all database operations', () => {
  const local = graphPostgresPoolConfig('postgresql://postgres:dummy@localhost/test');
  assert.equal(local.max, 2);
  assert.equal(local.ssl, false);
  for (const field of ['query_timeout', 'statement_timeout', 'connectionTimeoutMillis', 'lock_timeout', 'idle_in_transaction_session_timeout'] as const) {
    assert.equal(local[field], 20000);
  }
  const remote = graphPostgresPoolConfig('postgresql://postgres:dummy@database.example/test', { max: 1, ca: 'test-ca' });
  assert.equal(remote.max, 1);
  assert.deepEqual(remote.ssl, { rejectUnauthorized: true, ca: 'test-ca', minVersion: 'TLSv1.2' });
  assert.deepEqual(graphPostgresPoolConfig('postgresql://postgres:dummy@database.example/test?sslmode=verify-full').ssl,
    { rejectUnauthorized: true, minVersion: 'TLSv1.2' });
  for (const mode of ['disable', 'prefer', 'require', 'no-verify', 'verify-ca']) {
    assert.throws(() => graphPostgresPoolConfig(`postgresql://postgres:dummy@database.example/test?sslmode=${mode}`), /verified TLS/);
  }
  for (const option of ['sslrootcert=file', 'ssl=false', 'options=-c%20search_path=public']) {
    assert.throws(() => graphPostgresPoolConfig(`postgresql://postgres:dummy@database.example/test?${option}`));
  }
  assert.throws(() => graphPostgresPoolConfig('not-a-url'), /Invalid graph database URL/);
  assert.throws(() => graphPostgresPoolConfig('https://database.example/test'), /Invalid graph database URL/);
  assert.throws(() => graphPostgresPoolConfig('postgresql://localhost/test', { max: 3 as 2 }));
});

// Opt-in tests create and drop only a uniquely named database, never the supplied DB's tables.
// GRAPH_TEST_DATABASE_URL must be local with a postgres owner and CREATEDB; no deployment credentials are discovered.
test('PostgreSQL durable graph store', { skip: !process.env.GRAPH_TEST_DATABASE_URL, timeout: process.env.GRAPH_TEST_LARGE === '1' ? 600000 : 120000 }, async t => {
  const rootUrl = process.env.GRAPH_TEST_DATABASE_URL!;
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(rootUrl).hostname), 'Database tests require an explicitly supplied local PostgreSQL instance');
  const admin = new pg.Pool(graphPostgresPoolConfig(rootUrl, { max: 1 }));
  admin.on('error', () => {});
  const databaseName = `openpapers_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const url = new URL(rootUrl);
  url.pathname = `/${databaseName}`;
  const databaseUrl = url.toString();
  const sql = new pg.Pool(graphPostgresPoolConfig(databaseUrl, { max: 2 }));
  sql.on('error', () => {});
  t.after(async () => {
    await sql.end();
    try { await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`); }
    finally { await admin.end(); }
  });
  await migrateGraphJobs(databaseUrl);

  async function setup(context: TestContext, options: PostgresGraphStoreOptions = {}) {
    await sql.query('TRUNCATE openpapers.graph_jobs, openpapers.provider_budget, openpapers.graph_admission CASCADE');
    const store = new PostgresGraphStore(databaseUrl, { dailyRequestBudget: 20, pacingMs: 0, ...options });
    context.after(() => store.close());
    await store.ready;
    return store;
  }
  async function leased(store: PostgresGraphStore, origin = 'W1', candidates = 100, requests = 10): Promise<LeasedGraphJob> {
    const job = await store.create([origin], candidates, requests);
    const lease = await store.claim(job.id);
    assert.ok(lease);
    return lease;
  }

  await t.test('migration is additive, concurrent, repeatable and private', async () => {
    const retained = await sql.query(`INSERT INTO openpapers.graph_jobs
      (id, cache_key, version, origins, state, phase, candidate_budget, reference_budget, request_budget, checkpoint)
      VALUES ($1, repeat('a', 64), 'test-version', ARRAY['W1'], 'queued', 'acquire', 100, 1000, 10, '{}') RETURNING id`, [randomUUID()]);
    await sql.query('ALTER TABLE openpapers.graph_jobs DROP COLUMN caller_key');
    await Promise.all([migrateGraphJobs(databaseUrl), migrateGraphJobs(databaseUrl)]);
    assert.equal((await sql.query('SELECT caller_key FROM openpapers.graph_jobs WHERE id = $1', [retained.rows[0].id])).rows[0].caller_key, null);
    assert.equal((await sql.query('SELECT id FROM openpapers.graph_jobs WHERE id = $1', [retained.rows[0].id])).rows.length, 1);
    const marker = await sql.query('SELECT count(*)::integer AS count FROM openpapers.schema_migrations');
    assert.equal(marker.rows[0].count, 1);
    const tables = await sql.query(`SELECT c.relname, c.relrowsecurity, pg_get_userbyid(c.relowner) AS owner,
      coalesce((SELECT bool_or(privilege_type IS NOT NULL) FROM aclexplode(c.relacl) WHERE grantee = 0), false) AS public_access
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'openpapers' AND c.relkind = 'r'`);
    assert.equal(tables.rows.length, 6);
    for (const row of tables.rows) { assert.equal(row.relrowsecurity, true); assert.equal(row.owner, 'postgres'); assert.equal(row.public_access, false); }
    assert.equal((await sql.query(`SELECT count(*)::integer AS count FROM pg_policies WHERE schemaname = 'openpapers'`)).rows[0].count, 0);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      if ((await sql.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rows.length) {
        assert.equal((await sql.query(`SELECT has_schema_privilege($1, 'openpapers', 'USAGE') AS access`, [role])).rows[0].access, false);
      }
    }
  });

  await t.test('canonical create is atomic and rejects malformed or unsupported inputs', async context => {
    const store = await setup(context);
    const jobs = await Promise.all(Array.from({ length: 8 }, (_, i) => store.create(i % 2 ? ['W2', 'W1'] : ['W1', 'W2'], 100, 10)));
    assert.equal(new Set(jobs.map(job => job.id)).size, 1);
    assert.deepEqual(jobs[0].origins, ['W1', 'W2']);
    const claimed = (await store.claim(jobs[0].id))!;
    assert.deepEqual(claimed.checkpoint.frontier.map(task => task.ids), [['W1'], ['W2']]);
    assert.notEqual((await store.create(['W1', 'W2'], 101, 10)).id, jobs[0].id);
    assert.notEqual((await store.create(['W1', 'W2'], 100, 11)).id, jobs[0].id);
    for (const origins of [[], ['W1', 'W1'], ['W0'], ['W1', 'W2', 'W3', 'W4'], ['s2:abc'], ['W1000000000000000']]) {
      await assert.rejects(store.create(origins, 100, 10));
    }
    for (const value of [39, 50001, NaN, 40.5]) await assert.rejects(store.create(['W3'], value, 10));
    for (const value of [0, 1501, NaN, 1.5]) await assert.rejects(store.create(['W3'], 100, value));
    const publicView = (await store.get(jobs[0].id))!;
    assert.equal('checkpoint' in publicView, false); assert.equal('leaseToken' in publicView, false); assert.equal('cache_key' in publicView, false);
    assert.equal(await store.get('invalid'), undefined);
    assert.equal(await store.get(randomUUID()), undefined);
  });

  await t.test('global active queue limit survives concurrent creates', async context => {
    const store = await setup(context);
    const outcomes = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => store.create([`W${i + 1}`], 100, 10)));
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 4);
    for (const outcome of outcomes) if (outcome.status === 'rejected') assert.match(outcome.reason.message, /queue is full/);
  });

  await t.test('incompatible and expired active jobs release capacity and fence old workers', async context => {
    const store = await setup(context);
    const jobs = await Promise.all(['W1', 'W2', 'W3', 'W4'].map(id => store.create([id], 100, 10)));
    const owner = (await store.claim(jobs[0].id))!;
    await store.reserveRequest(owner);
    await sql.query(`UPDATE openpapers.graph_jobs SET version = 'obsolete-version', checkpoint = '{}' WHERE id <> $1`, [jobs[3].id]);
    await sql.query(`UPDATE openpapers.graph_jobs SET created_at = clock_timestamp() - interval '25 hours' WHERE id = $1`, [jobs[3].id]);
    assert.equal((await store.create(['W5'], 100, 10)).state, 'queued');
    for (const job of jobs) {
      const old = (await store.get(job.id))!;
      assert.equal(old.state, 'failed');
      assert.equal(old.stopReason, job.id === jobs[3].id ? 'job_expired' : 'incompatible_version');
    }
    const leases = await sql.query(`SELECT lease_token, lease_expires_at, request_reserved, checkpoint
      FROM openpapers.graph_jobs WHERE id = $1`, [owner.id]);
    assert.equal(leases.rows[0].lease_token, null); assert.equal(leases.rows[0].lease_expires_at, null);
    assert.equal(leases.rows[0].request_reserved, false); assert.equal(leases.rows[0].checkpoint.frontier.length, 0);
    await assert.rejects(store.commit(owner, page()), /lease/);
    assert.equal((await sql.query('SELECT daily_requests FROM openpapers.provider_budget')).rows[0].daily_requests, 1);
  });

  await t.test('failed matching cache entries are recreated atomically without deleting other failures', async context => {
    const store = await setup(context);
    const first = await leased(store);
    await store.commit(first, page([paper('W1', ['W9'])], { state: 'failed', error: 'Temporary failure' }));
    const other = await leased(store, 'W2');
    await store.commit(other, page([], { state: 'failed' }));
    const retries = await Promise.all(Array.from({ length: 8 }, () => store.create(['W1'], 100, 10)));
    assert.equal(new Set(retries.map(job => job.id)).size, 1);
    assert.notEqual(retries[0].id, first.id); assert.equal(retries[0].state, 'queued');
    assert.equal(retries[0].requestsUsed, 0); assert.equal(retries[0].acquiredCount, 0);
    assert.equal(await store.get(first.id), undefined); assert.equal((await store.get(other.id))!.state, 'failed');
    assert.equal((await sql.query('SELECT count(*)::integer AS count FROM openpapers.job_papers')).rows[0].count, 0);
  });

  await t.test('durable caller admission is one active job and two new submissions per UTC day', async context => {
    const store = await setup(context);
    const caller = 'a'.repeat(64);
    for (const invalid of ['', 'a'.repeat(63), 'A'.repeat(64), 'not-a-hash']) await assert.rejects(store.create(['W1'], 100, 10, invalid));
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => store.create([`W${i + 1}`], 100, 10, caller)));
    const successes = outcomes.filter(outcome => outcome.status === 'fulfilled');
    assert.equal(successes.length, 1);
    for (const outcome of outcomes) if (outcome.status === 'rejected') assert.match(outcome.reason.message, /active graph job/);
    const first = successes[0].value;
    assert.equal((await store.create(first.origins, 100, 10, caller)).id, first.id);
    await store.commit((await store.claim(first.id))!, page([], { state: 'completed', result: graph(first.origins) }));
    assert.equal((await store.create(first.origins, 100, 10, caller)).id, first.id);
    const second = await store.create(['W20'], 100, 10, caller);
    await store.commit((await store.claim(second.id))!, page([], { state: 'failed' }));
    await store.close();
    const restarted = new PostgresGraphStore(databaseUrl, { pacingMs: 0 });
    context.after(() => restarted.close());
    await assert.rejects(restarted.create(['W21'], 100, 10, caller), /daily graph submission limit/);
    await assert.rejects(restarted.create(['W20'], 100, 10, caller), /daily graph submission limit/);
    assert.equal((await restarted.get(second.id))!.state, 'failed', 'Denied retries roll back the failed-entry deletion');
    assert.equal((await restarted.create(first.origins, 100, 10, caller)).id, first.id, 'Completed hits still work at the daily limit');
    assert.equal((await sql.query('SELECT submissions FROM openpapers.graph_admission WHERE caller_key = $1', [caller])).rows[0].submissions, 2);
    const independent = await restarted.create(['W22'], 100, 10, 'b'.repeat(64));
    assert.equal(independent.state, 'queued');
    assert.equal('caller_key' in independent, false);
    await sql.query(`UPDATE openpapers.graph_admission SET budget_day = budget_day - 1`);
    assert.equal((await restarted.create(['W23'], 100, 10, caller)).state, 'queued');
    assert.equal((await sql.query('SELECT submissions FROM openpapers.graph_admission WHERE caller_key = $1', [caller])).rows[0].submissions, 1);
  });

  await t.test('queue rejection does not spend caller admission or bypass the four-slot cap', async context => {
    const store = await setup(context);
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => store.create([`W${i + 1}`], 100, 10, (i + 1).toString(16).repeat(64))));
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 4);
    assert.equal((await sql.query('SELECT sum(submissions)::integer AS count FROM openpapers.graph_admission')).rows[0].count, 4);
  });

  await t.test('SKIP LOCKED claims only one owner and can skip a locked queue row', async context => {
    const store = await setup(context);
    const one = await store.create(['W1'], 100, 10);
    const owners = await Promise.all([store.claim(one.id), store.claim(one.id), store.claim(one.id)]);
    assert.equal(owners.filter(Boolean).length, 1);
    const two = await store.create(['W2'], 100, 10);
    const three = await store.create(['W3'], 100, 10);
    const client = await sql.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM openpapers.graph_jobs WHERE id = $1 FOR UPDATE', [two.id]);
      assert.equal((await store.claim())!.id, three.id);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  await t.test('crash recovery preserves request charges and fences stale/forged owners', async context => {
    const store = await setup(context);
    const first = await leased(store);
    assert.equal((await store.reserveRequest(first)).allowed, true);
    await assert.rejects(store.reserveRequest(first), /already reserved/);
    await sql.query(`UPDATE openpapers.graph_jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [first.id]);
    await assert.rejects(store.commit(first, page([paper()])), /lease/);
    await assert.rejects(store.reserveRequest(first), /lease/);
    await assert.rejects(store.papers(first), /lease/);
    const recovered = (await store.claim(first.id))!;
    assert.notEqual(recovered.leaseToken, first.leaseToken);
    assert.equal(recovered.requestsUsed, 1);
    assert.deepEqual(recovered.checkpoint, first.checkpoint);
    await assert.rejects(store.commit(first, page([paper()])), /lease/);
    await assert.rejects(store.commit({ ...recovered, leaseToken: randomUUID() }, page()), /lease/);
    const done = await store.commit(recovered, page([paper('W1', ['W2'])]));
    assert.equal(done.requestsUsed, 1);
    assert.equal(done.state, 'queued');
    await assert.rejects(store.commit(recovered, page()), /lease/);
  });

  await t.test('lease expiry during a SQL page rolls back papers, edges and checkpoint', async context => {
    const store = await setup(context, { leaseMs: 1000 });
    const job = await leased(store);
    await sql.query(`CREATE FUNCTION openpapers.test_slow_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(1.1); RETURN NEW; END $$`);
    await sql.query(`CREATE TRIGGER test_slow BEFORE INSERT ON openpapers.job_papers FOR EACH ROW EXECUTE FUNCTION openpapers.test_slow_insert()`);
    try {
      await assert.rejects(store.commit(job, page([paper('W1', ['W2'])])), /lease/);
      assert.equal((await sql.query('SELECT count(*)::integer AS count FROM openpapers.job_papers')).rows[0].count, 0);
      assert.equal((await sql.query('SELECT count(*)::integer AS count FROM openpapers.job_references')).rows[0].count, 0);
      assert.equal((await store.get(job.id))!.acquiredCount, 0);
    } finally {
      await sql.query('DROP TRIGGER test_slow ON openpapers.job_papers');
      await sql.query('DROP FUNCTION openpapers.test_slow_insert()');
    }
  });

  await t.test('job budget and global daily budget persist across store restarts', async context => {
    const store = await setup(context, { dailyRequestBudget: 2 });
    let job = await leased(store, 'W1', 100, 1);
    assert.equal((await store.reserveRequest(job)).allowed, true);
    await store.commit(job, page([], { requestUsed: true }));
    assert.equal((await store.get(job.id))!.requestsUsed, 1, 'Commit must not double-charge a reserved request');
    job = (await store.claim(job.id))!;
    assert.deepEqual(await store.reserveRequest(job), { allowed: false, nextRunAt: null });
    await store.commit(job, page([], { state: 'failed' }));
    const second = await leased(store, 'W2');
    assert.equal((await store.reserveRequest(second)).allowed, true);
    await store.commit(second, page());
    await store.close();
    const restarted = new PostgresGraphStore(databaseUrl, { dailyRequestBudget: 2, pacingMs: 0 });
    context.after(() => restarted.close());
    const third = await leased(restarted, 'W3');
    const denied = await restarted.reserveRequest(third);
    assert.equal(denied.allowed, false);
    assert.ok(Date.parse(denied.nextRunAt!) > Date.now());
    assert.equal((await restarted.get(third.id))!.requestsUsed, 0);
    await sql.query(`UPDATE openpapers.provider_budget SET budget_day = budget_day - 1`);
    assert.equal((await restarted.reserveRequest(third)).allowed, true);
    assert.equal((await sql.query('SELECT daily_requests FROM openpapers.provider_budget')).rows[0].daily_requests, 1);
  });

  await t.test('global pacing and provider cooldown pause without spending another request', async context => {
    const store = await setup(context, { pacingMs: 1000 });
    const one = await leased(store);
    await store.reserveRequest(one);
    const cooldown = new Date(Date.now() + 60000).toISOString();
    await store.commit(one, page([], { state: 'paused', nextRunAt: cooldown, providerCooldownUntil: cooldown }));
    assert.equal(await store.claim(one.id), undefined);
    const two = await leased(store, 'W2');
    const denied = await store.reserveRequest(two);
    assert.equal(denied.allowed, false); assert.ok(Date.parse(denied.nextRunAt!) > Date.now() + 50000);
    assert.equal((await store.get(two.id))!.requestsUsed, 0);
    await store.commit(two, page());
    await sql.query(`UPDATE openpapers.provider_budget SET cooldown_until = NULL`);
    const retry = (await store.claim(two.id))!;
    assert.equal((await store.reserveRequest(retry)).allowed, false);
    await sql.query(`UPDATE openpapers.provider_budget SET next_request_at = clock_timestamp() - interval '1 second'`);
    assert.equal((await store.reserveRequest(retry)).allowed, true);
  });

  await t.test('elapsed pacing pauses become immediately claimable and ordinary pauses are job-local', async context => {
    const store = await setup(context, { pacingMs: 1 });
    const one = await leased(store);
    await store.reserveRequest(one);
    const saved = await store.commit(one, page([], { state: 'paused', nextRunAt: new Date(Date.now() - 1).toISOString() }));
    assert.equal(saved.state, 'queued'); assert.equal(saved.nextRunAt, null);
    const again = (await store.claim(one.id))!;
    assert.ok(again);
    await store.commit(again, page([], { state: 'paused', nextRunAt: new Date(Date.now() + 60000).toISOString() }));
    assert.equal((await sql.query('SELECT cooldown_until FROM openpapers.provider_budget')).rows[0].cooldown_until, null);
    const two = await leased(store, 'W2');
    assert.equal((await store.reserveRequest(two)).allowed, true);
  });

  await t.test('final requests persist explicit cooldown even when scoring or completing', async context => {
    const store = await setup(context);
    const one = await leased(store, 'W1', 100, 1);
    await store.reserveRequest(one);
    const cooldown = new Date(Date.now() + 60000).toISOString();
    await store.commit(one, page([], { phase: 'score', providerCooldownUntil: cooldown }));
    const scoring = (await store.claim(one.id))!;
    const later = new Date(Date.now() + 120000).toISOString();
    await store.commit(scoring, page([], { state: 'completed', result: graph(), providerCooldownUntil: later }));
    assert.equal((await sql.query('SELECT cooldown_until FROM openpapers.provider_budget')).rows[0].cooldown_until.toISOString(), later);
    const two = await leased(store, 'W2');
    const denied = await store.reserveRequest(two);
    assert.equal(denied.allowed, false); assert.equal(denied.nextRunAt, later);
    assert.equal((await store.get(two.id))!.requestsUsed, 0);
  });

  await t.test('concurrent reservations cannot overspend the global budget across store instances', async context => {
    const store = await setup(context, { dailyRequestBudget: 2 });
    const other = new PostgresGraphStore(databaseUrl, { dailyRequestBudget: 2, pacingMs: 0 });
    context.after(() => other.close());
    const leases = await Promise.all(['W1', 'W2', 'W3', 'W4'].map(id => leased(store, id)));
    const reservations = await Promise.all(leases.map((job, i) => (i % 2 ? other : store).reserveRequest(job)));
    assert.equal(reservations.filter(item => item.allowed).length, 2);
    assert.equal((await sql.query('SELECT daily_requests FROM openpapers.provider_budget')).rows[0].daily_requests, 2);
    assert.equal((await sql.query('SELECT sum(requests_used)::integer AS used FROM openpapers.graph_jobs')).rows[0].used, 2);
  });

  await t.test('page upsert replaces outgoing references, deduplicates and isolates revisions', async context => {
    const store = await setup(context);
    let one = await leased(store);
    const extended = { ...checkpoint, firstFetchedAt: new Date().toISOString(), missingReferences: 1, skippedTasks: 1, cursorStalls: 1,
      frontier: [{ kind: 'citing' as const, ids: ['W1'], cursor: '*', depth: 1, pages: 1, attempts: 2 }] };
    const saved = await store.commit(one, page([paper('W1', ['W2', 'W2', 'W3']), paper('W2', ['W1'])], { checkpoint: extended }));
    assert.equal(saved.acquiredCount, 2); assert.equal(saved.referenceCount, 3);
    one = (await store.claim(one.id))!;
    assert.deepEqual(one.checkpoint, extended);
    assert.deepEqual((await store.papers(one)).map(p => p.references), [['W2', 'W3'], ['W1']]);
    await store.commit(one, page([{ ...paper('W1', ['W4']), title: 'Updated' }]));
    one = (await store.claim(one.id))!;
    const revised = await store.papers(one);
    assert.equal(revised[0].title, 'Updated'); assert.deepEqual(revised[0].references, ['W4']);
    assert.equal((await store.get(one.id))!.referenceCount, 2);
    const two = await leased(store, 'W3');
    await store.commit(two, page([paper('W1', ['W9'])]));
    assert.deepEqual((await store.papers(one))[0].references, ['W4']);
    const metadata = (await sql.query('SELECT metadata FROM openpapers.job_papers LIMIT 1')).rows[0].metadata;
    assert.equal('references' in metadata, false); assert.equal('id' in metadata, false); assert.equal(metadata.version, 1);
  });

  await t.test('candidate cap admits only whole records and yields scoring', async context => {
    const store = await setup(context);
    const job = await leased(store, 'W1', 40);
    const committed = await store.commit(job, page(Array.from({ length: 42 }, (_, i) => paper(`W${i + 1}`, ['W99']))));
    assert.equal(committed.acquiredCount, 40); assert.equal(committed.referenceCount, 40);
    assert.equal(committed.phase, 'score'); assert.equal(committed.state, 'queued'); assert.match(committed.stopReason!, /candidate/);
    const scoring = (await store.claim(job.id))!;
    assert.equal(scoring.checkpoint.frontier.length, 0);
    assert.equal((await store.papers(scoring)).length, 40);
  });

  await t.test('per-job and aggregate reference limits never truncate existing metadata or edges', async context => {
    const store = await setup(context, { referenceBudget: 1000, totalReferenceBudget: 1000 });
    const refs = Array.from({ length: 600 }, (_, i) => `W${i + 10}`);
    let one = await leased(store);
    let saved = await store.commit(one, page([paper('W1', refs), paper('W2', refs)]));
    assert.equal(saved.acquiredCount, 1); assert.equal(saved.referenceCount, 600); assert.equal(saved.stopReason, 'reference_budget');
    one = (await store.claim(one.id))!;
    const enlarged = Array.from({ length: 1001 }, (_, i) => `W${i + 10}`);
    saved = await store.commit(one, page([{ ...paper('W1', enlarged), title: 'Must not replace' }]));
    assert.equal(saved.referenceCount, 600);
    one = (await store.claim(one.id))!;
    const intact = (await store.papers(one))[0];
    assert.equal(intact.title, 'Paper W1'); assert.equal(intact.references.length, 600);
    const two = await leased(store, 'W3');
    const capped = await store.commit(two, page([paper('W3', refs)]));
    assert.equal(capped.acquiredCount, 0); assert.equal(capped.stopReason, 'total_reference_budget');
    assert.equal((await sql.query('SELECT count(*)::integer AS count FROM openpapers.job_references')).rows[0].count, 600);
  });

  await t.test('aggregate metadata cap bounds large abstracts without partial records', async context => {
    const store = await setup(context, { totalMetadataBytes: 1024 });
    const job = await leased(store);
    const capped = await store.commit(job, page([{ ...paper(), abstract: 'x'.repeat(2000) }]));
    assert.equal(capped.acquiredCount, 0); assert.equal(capped.referenceCount, 0);
    assert.equal(capped.stopReason, 'storage_budget');
    assert.equal((await sql.query('SELECT count(*)::integer AS count FROM openpapers.job_papers')).rows[0].count, 0);
  });

  await t.test('concurrent page admissions cannot overspend aggregate reference storage', async context => {
    const store = await setup(context, { referenceBudget: 1000, totalReferenceBudget: 1000 });
    const refs = Array.from({ length: 600 }, (_, i) => `W${i + 10}`);
    const one = await leased(store);
    const two = await leased(store, 'W2');
    const commits = await Promise.all([store.commit(one, page([paper('W1', refs)])), store.commit(two, page([paper('W2', refs)]))]);
    assert.equal(commits.reduce((sum, job) => sum + job.referenceCount, 0), 600);
    assert.equal(commits.filter(job => job.stopReason === 'total_reference_budget').length, 1);
  });

  await t.test('malformed checkpoints/pages/results are rejected without acknowledging a lease', async context => {
    const store = await setup(context);
    const job = await leased(store);
    const invalid: unknown[] = [
      null, page([null as unknown as Paper]), page([paper('s2:abc')]), page([paper('W1', ['s2:abc'])]), page(Array.from({ length: 101 }, () => paper())),
      page([paper('W1', Array.from({ length: 2501 }, (_, i) => `W${i + 1}`))]),
      page([], { fetchedAt: 'invalid' }), page([], { checkpoint: { ...checkpoint, frontier: [{ kind: 'batch', ids: [], depth: 0 }] } }),
      page([], { checkpoint: { ...checkpoint, frontier: [{ kind: 'batch', ids: ['W1'], depth: 3 }] } }),
      page([], { checkpoint: { ...checkpoint, frontier: [{ kind: 'batch', ids: ['W1'], depth: 0, cursor: 'x'.repeat(2001) }] } }),
      page([], { checkpoint: { ...checkpoint, frontier: [{ kind: 'batch', ids: ['W1'], depth: 0, pages: 1001 }] } }),
      page([], { checkpoint: { ...checkpoint, frontier: Array.from({ length: 1001 }, () => ({ kind: 'batch', ids: ['W1'], depth: 0 })) } }),
      page([], { checkpoint: { ...checkpoint, frontier: [{ kind: 'batch', ids: Array.from({ length: 101 }, () => 'W1'), depth: 0 }] } }),
      page([paper('W1', ['W2'])], { state: 'paused', nextRunAt: null }),
      page([], { providerCooldownUntil: 'invalid' }), page([], { state: 'completed' }), page([], { result: graph() }),
      page([], { state: 'completed', result: graph(['W2']) }),
      page([], { state: 'completed', result: { ...graph(), meta: { ...graph().meta, provider: 'semantic-scholar' } } }),
      page([], { state: 'completed', result: { ...graph(), nodes: [] } }), page([], { requestUsed: true }),
      { ...page(), checkpoint: { ...checkpoint, unexpected: 'unbounded' } },
    ];
    for (const value of invalid) await assert.rejects(store.commit(job, value as PageCommit));
    const persisted = (await store.get(job.id))!;
    assert.equal(persisted.state, 'running'); assert.equal(persisted.acquiredCount, 0); assert.equal(persisted.referenceCount, 0);
    assert.equal((await sql.query('SELECT count(*)::integer AS count FROM openpapers.job_papers')).rows[0].count, 0);
    await store.commit(job, page([paper()]));
  });

  await t.test('results over 4 MiB are rejected, never truncated or published', async context => {
    const store = await setup(context);
    const job = await leased(store);
    const origin = graph().nodes[0];
    const bigPaper = { ...origin, abstract: 'x'.repeat(30000), references: Array.from({ length: 2500 }, (_, i) => `W${100000000000000 + i}`) };
    const oversized: GraphResponse = { ...graph(),
      nodes: Array.from({ length: 40 }, (_, i) => ({ ...bigPaper, id: `W${i + 1}`, isOrigin: i === 0 })),
      prior: Array.from({ length: 20 }, () => bigPaper), derivative: Array.from({ length: 20 }, () => bigPaper) };
    assert.ok(Buffer.byteLength(JSON.stringify(oversized)) > 4 * 1024 * 1024);
    await assert.rejects(store.commit(job, page([], { state: 'completed', result: oversized })), /Result is too large/);
    assert.equal((await store.get(job.id))!.result, null);
    assert.equal((await store.get(job.id))!.state, 'running');
  });

  await t.test('completed results are versioned, validated and retained with bounded pruning', async context => {
    const store = await setup(context, { maxCompletedJobs: 1 });
    const first = await leased(store);
    await store.commit(first, page([paper('W1', ['W2'])], { state: 'completed', result: graph() }));
    assert.equal((await store.get(first.id))!.result!.meta.provider, 'openalex');
    assert.equal(await store.claim(first.id), undefined);
    assert.equal((await store.create(['W1'], 100, 10)).id, first.id);
    const second = await leased(store, 'W2');
    await store.commit(second, page([paper('W2', ['W1'])], { state: 'completed', result: graph(['W2']) }));
    assert.equal(await store.get(first.id), undefined);
    assert.equal((await sql.query('SELECT count(*)::integer AS count FROM openpapers.job_papers')).rows[0].count, 1);
    assert.equal((await sql.query('SELECT count(*)::integer AS count FROM openpapers.job_references')).rows[0].count, 1);
    await sql.query(`UPDATE openpapers.graph_jobs SET updated_at = clock_timestamp() - interval '8 days' WHERE id = $1`, [second.id]);
    await store.create(['W3'], 100, 10);
    assert.equal(await store.get(second.id), undefined);
  });

  await t.test('papers keyset batches cross 2000-record boundaries with exact counts', async context => {
    const store = await setup(context);
    let job = await leased(store, 'W1', 2100);
    for (let batch = 0; batch < 21; batch++) {
      await store.commit(job, page(Array.from({ length: 100 }, (_, i) => paper(`W${batch * 100 + i + 1}`, ['W999', 'W998']))));
      job = (await store.claim(job.id))!;
    }
    const records = await store.papers(job);
    assert.equal(records.length, 2100); assert.equal(new Set(records.map(p => p.id)).size, 2100);
    assert.equal(records.reduce((count, p) => count + p.references.length, 0), 4200);
  });

  await t.test('paper reads reject count mismatches and observe pre-aborted signals', async context => {
    const store = await setup(context);
    let job = await leased(store);
    await store.commit(job, page([paper('W1', ['W2'])]));
    job = (await store.claim(job.id))!;
    await assert.rejects(store.papers(job, AbortSignal.abort()), { name: 'AbortError' });
    await sql.query('UPDATE openpapers.graph_jobs SET acquired_count = 2 WHERE id = $1', [job.id]);
    await assert.rejects(store.papers(job), /counts are inconsistent/);
    await sql.query('UPDATE openpapers.graph_jobs SET acquired_count = 0 WHERE id = $1', [job.id]);
    await assert.rejects(store.papers(job), /counts are inconsistent/);
    await sql.query('UPDATE openpapers.graph_jobs SET acquired_count = 1, reference_count = 0 WHERE id = $1', [job.id]);
    await assert.rejects(store.papers(job), /counts are inconsistent/);
    await sql.query('UPDATE openpapers.graph_jobs SET reference_count = 1 WHERE id = $1', [job.id]);
    assert.equal((await store.papers(job)).length, 1);
  });

  await t.test('abort waits for in-flight SQL before rollback and client reuse', async context => {
    const store = await setup(context, { max: 1 });
    let job = await leased(store);
    await store.commit(job, page([paper()]));
    job = (await store.claim(job.id))!;
    const pool = (store as unknown as { pool: pg.Pool }).pool;
    const client = await pool.connect();
    const original = client.query;
    const controller = new AbortController();
    let finished = false;
    let backend = 0;
    client.query = (async (config: any, ...args: any[]) => {
      if (typeof config?.text === 'string' && config.text.startsWith('SELECT p.id, p.metadata,')) {
        backend = (await Reflect.apply(original, client, ['SELECT pg_backend_pid() AS pid'])).rows[0].pid;
        setTimeout(() => controller.abort(), 20);
        const result = await Reflect.apply(original, client, [{ ...config,
          text: `WITH delay AS MATERIALIZED (SELECT pg_sleep(0.2)) ${config.text.replace('FROM openpapers.job_papers p WHERE', 'FROM openpapers.job_papers p CROSS JOIN delay WHERE')}` }]);
        finished = true;
        return result;
      }
      return Reflect.apply(original, client, [config, ...args]);
    }) as typeof client.query;
    client.release();
    try {
      await assert.rejects(store.papers(job, controller.signal), { name: 'AbortError' });
      assert.equal(finished, true, 'Do not reject/release while backend SQL is in flight');
      const reused = await pool.query('SELECT pg_backend_pid() AS pid, current_setting(\'statement_timeout\') AS timeout');
      assert.equal(reused.rows[0].pid, backend); assert.equal(reused.rows[0].timeout, '20s');
      assert.equal((await store.get(job.id))!.state, 'running');
    } finally { client.query = original; }
    assert.equal((await store.papers(job)).length, 1);
  });

  await t.test('remaining read deadline cancels backend SQL with transaction-local statement timeout', async context => {
    const store = await setup(context, { max: 1, leaseMs: 3000 });
    let job = await leased(store);
    await store.commit(job, page([paper()]));
    job = (await store.claim(job.id))!;
    await sql.query(`UPDATE openpapers.graph_jobs SET lease_expires_at = clock_timestamp() + interval '1800 milliseconds' WHERE id = $1`, [job.id]);
    const pool = (store as unknown as { pool: pg.Pool }).pool;
    const client = await pool.connect();
    const original = client.query;
    client.query = ((config: any, ...args: any[]) => {
      if (typeof config?.text === 'string' && config.text.startsWith('SELECT p.id, p.metadata,')) {
        config = { ...config, text: `WITH delay AS MATERIALIZED (SELECT pg_sleep(3)) ${config.text.replace('FROM openpapers.job_papers p WHERE', 'FROM openpapers.job_papers p CROSS JOIN delay WHERE')}` };
      }
      return Reflect.apply(original, client, [config, ...args]);
    }) as typeof client.query;
    client.release();
    const started = Date.now();
    try {
      await assert.rejects(store.papers(job), { code: '57014' });
      assert.ok(Date.now() - started < 2500, 'Server must cancel, not wait for the three-second query');
      assert.equal((await pool.query("SELECT current_setting('statement_timeout') AS timeout")).rows[0].timeout, '20s');
    } finally { client.query = original; }
  });

  await t.test('driver timeouts destroy the connection rather than reuse running SQL', async context => {
    const store = await setup(context, { max: 1 });
    const job = await leased(store);
    const pool = (store as unknown as { pool: pg.Pool }).pool;
    const client = await pool.connect();
    const original = client.query;
    const backend = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    client.query = ((config: any, ...args: any[]) => {
      if (typeof config?.text === 'string' && config.text.startsWith('SELECT p.id, p.metadata,')) {
        config = { ...config, text: 'SELECT pg_sleep(1)', values: [], query_timeout: 20 };
      }
      return Reflect.apply(original, client, [config, ...args]);
    }) as typeof client.query;
    client.release();
    try {
      await assert.rejects(store.papers(job), /Query read timeout/);
      const replacement = await pool.query('SELECT pg_backend_pid() AS pid');
      assert.notEqual(replacement.rows[0].pid, backend, 'Timed-out backend cannot be checked out again');
      assert.equal((await store.get(job.id))!.state, 'running');
    } finally { client.query = original; }
  });

  await t.test('current runner acquires multiple origins and publishes from durable records after restart', async context => {
    const { GraphJobRunner } = await import('./graph-jobs.ts');
    const store = await setup(context);
    const job = await store.create(['W2', 'W1'], 100, 2);
    let calls = 0;
    const fetchedAt = new Date().toISOString();
    const provider = {
      getPaper: async (id: string) => { calls++; return { id: `https://openalex.org/${id}`, display_name: `Acquired ${id}`, referenced_works: ['https://openalex.org/W9'] }; },
      request: async <T>() => { throw new Error('Unexpected non-seed request'); return {} as T; },
      metadata: () => ({ source: 'live' as const, fetchedAt }),
    };
    const runner = new GraphJobRunner(store, provider);
    assert.equal((await runner.runStep(job.id))!.acquiredCount, 1);
    assert.equal((await runner.runStep(job.id))!.phase, 'score');
    await store.close();
    const restarted = new PostgresGraphStore(databaseUrl, { dailyRequestBudget: 20, pacingMs: 0 });
    context.after(() => restarted.close());
    const published = (await new GraphJobRunner(restarted, provider).runStep(job.id))!;
    assert.equal(published.state, 'completed');
    assert.deepEqual(published.result!.origins, ['W1', 'W2']);
    assert.equal(published.result!.meta.fetchedAt, fetchedAt);
    assert.equal(published.referenceCount, 2); assert.equal(published.requestsUsed, 2); assert.equal(calls, 2);
  });

  await t.test('50k-paper / 2M-reference durable boundary', { skip: process.env.GRAPH_TEST_LARGE !== '1' }, async context => {
    const store = await setup(context, { referenceBudget: 2000000, totalReferenceBudget: 2000000, leaseMs: 300000 });
    let job = await leased(store, 'W100000000000000', 50000);
    const refs = Array.from({ length: 40 }, (_, i) => `W${200000000000000 + i}`);
    const started = Date.now();
    for (let batch = 0; batch < 500; batch++) {
      const saved = await store.commit(job, page(Array.from({ length: 100 }, (_, i) => paper(`W${100000000000000 + batch * 100 + i}`, refs))));
      assert.equal(saved.acquiredCount, (batch + 1) * 100);
      assert.equal(saved.referenceCount, (batch + 1) * 4000);
      job = (await store.claim(job.id))!;
    }
    const acquiredMs = Date.now() - started;
    const localStart = Date.now();
    const loaded = await store.papers(job);
    const localReadMs = Date.now() - localStart;
    assert.equal(loaded.length, 50000);
    assert.equal(new Set(loaded.map(p => p.id)).size, 50000);
    assert.equal(loaded.reduce((sum, p) => sum + p.references.length, 0), 2000000);
    for (const record of loaded) assert.deepEqual(record.references, refs);
    // Real local PostgreSQL data/queries, synthetic 200 ms latency per client round trip.
    // This is not a Supabase or remote-network benchmark.
    const pool = (store as unknown as { pool: pg.Pool }).pool;
    const clients = await Promise.all([pool.connect(), pool.connect()]);
    let reads = 0;
    let roundTrips = 0;
    const originals = clients.map(client => client.query);
    clients.forEach((client, i) => {
      client.query = (async (config: any, ...args: any[]) => {
        roundTrips++;
        if (typeof config?.text === 'string' && config.text.startsWith('SELECT p.id, p.metadata,')) reads++;
        await delay(200);
        return Reflect.apply(originals[i], client, [config, ...args]);
      }) as typeof client.query;
      client.release();
    });
    const remoteStart = Date.now();
    try {
      const simulated = await store.papers(job, AbortSignal.timeout(40000));
      assert.equal(simulated.length, 50000); assert.equal(new Set(simulated.map(p => p.id)).size, 50000);
      assert.equal(simulated.reduce((sum, p) => sum + p.references.length, 0), 2000000);
      for (const record of simulated) assert.deepEqual(record.references, refs);
      assert.equal(reads, 26, '25 full 2000-record batches plus an empty end-of-stream batch');
      assert.ok(Date.now() - remoteStart < 30000);
    } finally { clients.forEach((client, i) => { client.query = originals[i]; }); }
    const simulatedMs = Date.now() - remoteStart;
    const disk = await sql.query(`SELECT sum(pg_total_relation_size(c.oid))::bigint AS bytes
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'openpapers' AND c.relkind = 'r'`);
    context.diagnostic(`50k / 2M synthetic records on real local PostgreSQL: acquisition ${acquiredMs} ms, local read ${localReadMs} ms, injected 200 ms/round-trip read ${simulatedMs} ms (${reads} read batches, ${roundTrips} round trips), schema storage ${disk.rows[0].bytes} bytes`);
  });

  await t.test('ready is health-only and refuses missing migration without creating it', async context => {
    await sql.query('DELETE FROM openpapers.schema_migrations');
    const store = new PostgresGraphStore(databaseUrl);
    context.after(() => store.close());
    await assert.rejects(store.ready, /migration is missing/);
    assert.equal((await sql.query('SELECT count(*)::integer AS count FROM openpapers.schema_migrations')).rows[0].count, 0);
    await migrateGraphJobs(databaseUrl);
  });
});
