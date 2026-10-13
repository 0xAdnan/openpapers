import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import pg from 'pg';
import { migrateGraphJobs } from '../scripts/migrate-graph-jobs.ts';
import { GraphJobSchema, type GraphJob } from '../shared/graph-jobs.ts';
import { GraphResponseSchema, PaperSchema } from '../shared/schemas.ts';
import type { GraphResponse, Paper } from '../shared/types.ts';
import { PersistentCache } from './cache.ts';
import { GraphJobRunner } from './graph-jobs.ts';
import { createApp } from './index.ts';
import { normalizeWork, OPENALEX_ORIGIN, OpenAlexProvider, SELECT, type OpenAlexWork, type WorksPage } from './openalex.ts';
import { graphPostgresPoolConfig, PostgresGraphJobStore, type PostgresGraphStoreOptions } from './postgres-store.ts';
import { SemanticService } from './semantic-service.ts';
import { PaperService } from './service.ts';

const cacheDirectory = `/tmp/opencode/graph-integration-unused-${randomUUID()}`;
const workerToken = 'graph-integration-dummy-worker-token';
const providerKey = 'graph-integration-dummy-openalex-key';
const storeOptions = { dailyRequestBudget: 1500, pacingMs: 0, referenceBudget: 500_000,
  totalReferenceBudget: 1_000_000, totalMetadataBytes: 64 * 1024 * 1024 };

// Exercise the real provider transport/provenance, but never read or write shared caches.
class TransientCache extends PersistentCache {
  constructor() { super(cacheDirectory); }
  override async get<T>(): Promise<undefined> { return undefined; }
  override async list<T>(): Promise<[]> { return []; }
  override async set<T>(): Promise<void> {}
}

function work(id: string, references: string[] = []): OpenAlexWork {
  return { id: `https://openalex.org/${id}`, display_name: `Synthetic integration fixture ${id}`,
    publication_year: 2020, cited_by_count: 0, referenced_works: references, topics: [{ display_name: 'Same fixture topic' }] };
}

function transport(handler: (url: URL, signal: AbortSignal) => OpenAlexWork | WorksPage | Response | Promise<OpenAlexWork | WorksPage | Response> = url =>
  url.pathname === '/works' ? { results: [], meta: { count: 0, next_cursor: null } } : work(url.pathname.slice(7))) {
  const calls: { url: URL; signal: AbortSignal }[] = [];
  const provider = new OpenAlexProvider({ cache: new TransientCache(), apiKey: providerKey, maxRequests: 1500,
    fetch: async (input, options) => {
      const url = new URL(String(input));
      const signal = options!.signal!;
      assert.equal(url.origin, OPENALEX_ORIGIN);
      assert.equal(url.searchParams.get('select'), SELECT);
      assert.equal(options!.redirect, 'error');
      assert.equal(new Headers(options!.headers).get('authorization'), `Bearer ${providerKey}`);
      assert.ok(!url.href.includes(providerKey));
      if (url.pathname === '/works') {
        assert.equal(url.searchParams.get('per_page'), '100');
        const filter = url.searchParams.get('filter')!;
        assert.ok(filter.startsWith('openalex_id:') || filter.startsWith('cites:'));
        assert.ok(filter.split(':')[1].split('|').length <= (filter.startsWith('cites:') ? 8 : 100));
      }
      signal.throwIfAborted();
      calls.push({ url, signal });
      const value = await handler(url, signal);
      signal.throwIfAborted();
      return value instanceof Response ? value : Response.json(value);
    } });
  return { provider, calls };
}

async function listen(context: TestContext, options: Parameters<typeof createApp>[0] = {}) {
  const cache = new TransientCache();
  const noFetch = transport(() => { assert.fail('Quick/offline APIs must not fetch OpenAlex'); });
  const service = new PaperService(cache, true, noFetch.provider);
  const semanticService = new SemanticService(cache, true);
  await Promise.all([service.ready, semanticService.ready]);
  const background: Promise<unknown>[] = [];
  const { app } = createApp({ service, semanticService, offline: true, defaultProvider: 'openalex', rateLimit: 1000,
    cacheDirectory, distPath: cacheDirectory, background: task => background.push(task), ...options });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const close = () => new Promise<void>((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
  context.after(close);
  const origin = `http://127.0.0.1:${address.port}`;
  const json = async (path: string, status = 200, init?: RequestInit) => {
    const response = await fetch(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(10_000) });
    const text = await response.text();
    assert.equal(response.status, status, `${path}: ${text}`);
    for (const secret of [workerToken, providerKey]) assert.ok(!text.includes(secret), 'HTTP response leaked a key');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return JSON.parse(text);
  };
  const submit = async (origins: string[], candidateBudget = 700) => GraphJobSchema.parse(await json('/api/graph-jobs', 202,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origins, candidateBudget }) }));
  const get = async (id: string) => {
    const value = await json(`/api/graph-jobs/${id}`);
    for (const privateField of ['checkpoint', 'leaseToken', 'lease_token', 'cache_key', 'request_reserved']) {
      assert.equal(privateField in value, false);
    }
    return GraphJobSchema.parse(value);
  };
  return { origin, json, submit, get, background, close };
}

function verifyEvidence(graph: GraphResponse, papers: Paper[]) {
  const records = new Map(papers.map(paper => [paper.id, paper]));
  assert.equal(records.size, papers.length);
  const outgoing = new Map(papers.map(paper => [paper.id, new Set(paper.references.filter(id => id !== paper.id))]));
  const incoming = (id: string) => papers.filter(paper => outgoing.get(paper.id)!.has(id));
  const evidence = (a: string, b: string) => {
    const ra = outgoing.get(a)!, rb = outgoing.get(b)!;
    const ca = incoming(a), cb = incoming(b);
    const shared = [...ra].filter(id => rb.has(id)).length;
    const co = ca.filter(paper => outgoing.get(paper.id)!.has(b)).length;
    const weight = ((ra.size && rb.size ? shared / Math.sqrt(ra.size * rb.size) : 0)
      + (ca.length && cb.length ? co / Math.sqrt(ca.length * cb.length) : 0)) / 2;
    return { shared, co, weight };
  };
  const ids = new Set(graph.nodes.map(paper => paper.id));
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    assert.ok(ids.has(edge.source) && ids.has(edge.target));
    assert.notEqual(edge.source, edge.target);
    const key = [edge.source, edge.target].sort().join(':');
    assert.ok(!seen.has(key));
    seen.add(key);
    const expected = evidence(edge.source, edge.target);
    assert.equal(edge.sharedReferences, expected.shared);
    assert.equal(edge.coCitations, expected.co);
    assert.ok(expected.shared + expected.co > 0);
    assert.ok(Math.abs(edge.weight - expected.weight) < 1e-12);
  }
  for (const node of graph.nodes) {
    assert.equal(node.title, records.get(node.id)!.title);
    assert.deepEqual(node.references, records.get(node.id)!.references);
    assert.equal(node.graphConnections, graph.edges.filter(edge => edge.source === node.id || edge.target === node.id).length);
  }
  for (const paper of graph.prior) {
    assert.equal(paper.graphConnections, graph.nodes.filter(node => outgoing.get(node.id)!.has(paper.id)).length);
    assert.ok(paper.graphConnections >= 2);
  }
  for (const paper of graph.derivative) {
    assert.equal(paper.graphConnections, [...outgoing.get(paper.id)!].filter(id => ids.has(id)).length);
    assert.ok(paper.graphConnections >= 2);
  }
  return evidence;
}

// Use only an explicitly supplied disposable PostgreSQL 16 DB. No CREATEDB, roles,
// volumes, live scholarship, deployment env files, or changes outside our owned schema.
test('PostgreSQL graph runner and Express job integration', { skip: !process.env.GRAPH_TEST_DATABASE_URL, timeout: 120_000 }, async t => {
  const databaseUrl = process.env.GRAPH_TEST_DATABASE_URL!;
  const saved = Object.fromEntries(['DATABASE_URL', 'GRAPH_CANDIDATE_BUDGET', 'GRAPH_REQUEST_BUDGET', 'GRAPH_WORKER_TOKEN',
    'PAPERS_API_KEY', 'S2_API_KEY'].map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  delete process.env.DATABASE_URL;
  delete process.env.S2_API_KEY;
  process.env.GRAPH_CANDIDATE_BUDGET = '700';
  process.env.GRAPH_REQUEST_BUDGET = '1500';
  process.env.GRAPH_WORKER_TOKEN = workerToken;
  process.env.PAPERS_API_KEY = providerKey;
  const sql = new pg.Pool(graphPostgresPoolConfig(databaseUrl));
  let ownedSchema = false;
  t.after(async () => {
    try { if (ownedSchema) await sql.query('DROP SCHEMA openpapers CASCADE'); }
    finally { await sql.end(); }
  });
  const preflight = await sql.query(`SELECT to_regnamespace('openpapers') AS existing,
    current_setting('server_version_num')::integer AS version`);
  assert.equal(preflight.rows[0].existing, null, 'Refusing to alter an existing openpapers schema; supply an isolated disposable DB');
  assert.ok(preflight.rows[0].version >= 160000 && preflight.rows[0].version < 170000, 'Use PostgreSQL 16');
  await migrateGraphJobs(databaseUrl);
  ownedSchema = true;

  async function setup(context: TestContext, options: PostgresGraphStoreOptions = {}) {
    await sql.query('DELETE FROM openpapers.graph_jobs');
    await sql.query('DELETE FROM openpapers.provider_budget');
    const store = new PostgresGraphJobStore(databaseUrl, { ...storeOptions, ...options });
    context.after(() => store.close());
    await store.ready;
    return store;
  }

  await t.test('migration is repeatable and SQL privileges remain private to postgres', async () => {
    await migrateGraphJobs(databaseUrl);
    const tables = await sql.query(`SELECT c.relname, c.relrowsecurity, pg_get_userbyid(c.relowner) AS owner,
      EXISTS (SELECT 1 FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) WHERE grantee = 0) AS public_access
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'openpapers' AND c.relkind = 'r'`);
    assert.equal(tables.rows.length, 5);
    for (const row of tables.rows) {
      assert.equal(row.owner, 'postgres'); assert.equal(row.relrowsecurity, true); assert.equal(row.public_access, false);
    }
    const schema = await sql.query(`SELECT pg_get_userbyid(nspowner) AS owner,
      EXISTS (SELECT 1 FROM aclexplode(coalesce(nspacl, acldefault('n', nspowner))) WHERE grantee = 0) AS public_access
      FROM pg_namespace WHERE nspname = 'openpapers'`);
    assert.deepEqual(schema.rows[0], { owner: 'postgres', public_access: false });
    assert.equal((await sql.query(`SELECT count(*)::integer AS count FROM pg_policies WHERE schemaname = 'openpapers'`)).rows[0].count, 0);
    assert.equal((await sql.query('SELECT count(*)::integer AS count FROM openpapers.schema_migrations')).rows[0].count, 1);
    const roles = await sql.query(`SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')`);
    for (const { rolname } of roles.rows) {
      assert.equal((await sql.query(`SELECT has_schema_privilege($1, 'openpapers', 'USAGE') AS access`, [rolname])).rows[0].access, false);
    }
    t.diagnostic(`PostgreSQL 16; postgres-owned schema/tables; RLS enabled without policies; PUBLIC denied; ${roles.rows.length} existing Supabase roles checked (none created).`);
  });

  await t.test('config is available with only a real jobStore, unavailable without DB, and quick APIs stay offline', async context => {
    const store = await setup(context);
    const enabled = await listen(context, { jobStore: store });
    assert.deepEqual(await enabled.json('/api/graph-jobs/config'), { available: true, candidateBudget: 700,
      maxCandidateBudget: 50000, requestBudget: 1500, persistence: 'postgres' });
    const examples = await enabled.json('/api/examples');
    const quick = await enabled.json(`/api/graph?ids=${examples[0].id}`);
    assert.equal(quick.meta.source, 'snapshot');
    const missing = await listen(context);
    assert.equal((await missing.json('/api/graph-jobs/config')).available, false);
    await missing.json('/api/graph-jobs', 503, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"origins":["W1"]}' });
    await missing.json(`/api/graph-jobs/${randomUUID()}`, 503);
    await missing.json('/api/internal/graph-worker', 503, { method: 'POST', headers: { Authorization: `Bearer ${workerToken}` } });
    await sql.query('DELETE FROM openpapers.schema_migrations');
    const unmigrated = new PostgresGraphJobStore(databaseUrl, storeOptions);
    context.after(() => unmigrated.close());
    await assert.rejects(unmigrated.ready, /migration is missing/);
    try {
      const unavailable = await listen(context, { jobStore: unmigrated });
      assert.equal((await unavailable.json('/api/graph-jobs/config')).available, false);
    } finally { await migrateGraphJobs(databaseUrl); }
  });

  await t.test('config readiness respects the HTTP deadline and releases blocked database handles', async context => {
    await setup(context);
    const blocker = await sql.connect();
    let store: PostgresGraphJobStore | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE openpapers.schema_migrations IN ACCESS EXCLUSIVE MODE');
      store = new PostgresGraphJobStore(databaseUrl, storeOptions);
      const api = await listen(context, { jobStore: store, requestTimeoutMs: 50 });
      await api.json('/api/graph-jobs/config', 504);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      if (store) { await store.ready; await store.close(); }
    }
  });

  await t.test('POST 202 persists canonical ID/budget clamp and GET reports progress and the final result', async context => {
    const store = await setup(context);
    const fake = transport();
    const runner = new GraphJobRunner(store, fake.provider);
    const api = await listen(context, { jobStore: store, jobRunner: runner });
    const job = await api.submit(['W2', 'W1'], 50000);
    assert.deepEqual(job.origins, ['W1', 'W2']);
    assert.equal(job.state, 'queued'); assert.equal(job.result, null); assert.equal(job.acquiredCount, 0);
    assert.equal(job.candidateBudget, 700); assert.equal(job.requestBudget, 1500); assert.equal(job.referenceBudget, 500_000);
    const row = (await sql.query('SELECT id, origins, candidate_budget FROM openpapers.graph_jobs WHERE id = $1', [job.id])).rows[0];
    assert.deepEqual(row, { id: job.id, origins: ['W1', 'W2'], candidate_budget: 700 });
    assert.equal((await store.create(['W1', 'W2'], 700, 1500)).id, job.id);
    assert.equal(api.background.length, 1);
    await Promise.all(api.background);
    const progress = await api.get(job.id);
    assert.equal(progress.acquiredCount, 1); assert.equal(progress.requestsUsed, 1); assert.equal(progress.result, null);
    assert.ok((await runner.runBatch(10)).length > 0);
    const completed = await api.get(job.id);
    assert.equal(completed.state, 'completed'); assert.equal(completed.acquiredCount, 2);
    assert.deepEqual(completed.result!.edges, []);
    assert.deepEqual(completed.result!.origins, ['W1', 'W2']);
    assert.equal((await api.json('/api/graph-jobs', 200, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: '{"origins":["W2","W1"],"candidateBudget":50000}' })).id, job.id);
    await api.json(`/api/graph-jobs/${randomUUID()}`, 404);
    assert.equal(fake.calls.length, completed.requestsUsed);
  });

  await t.test('worker rejects missing/wrong credentials and valid Bearer runs the real batch to completion', async context => {
    const store = await setup(context);
    const fake = transport();
    const api = await listen(context, { jobStore: store, jobRunner: new GraphJobRunner(store, fake.provider) });
    const job = await store.create(['W1'], 700, 1500);
    for (const authorization of [undefined, `Bearer ${'x'.repeat(workerToken.length)}`, workerToken, `bearer ${workerToken}`]) {
      await api.json('/api/internal/graph-worker', 401, { method: 'POST', headers: authorization ? { Authorization: authorization } : {} });
    }
    assert.equal(fake.calls.length, 0); assert.equal((await api.get(job.id)).requestsUsed, 0);
    const response = await api.json('/api/internal/graph-worker', 200, { method: 'POST', headers: { Authorization: `Bearer ${workerToken}` } });
    assert.equal(response.processedSteps, 5);
    assert.equal((await api.get(job.id)).state, 'completed');
    assert.equal(fake.calls.length, 3);
  });

  await t.test('disconnecting the submit socket does not abort the detached background runner', async context => {
    const store = await setup(context);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fake = transport(async url => {
      if (url.pathname === '/works/W1') { enter(); await gate; return work('W1'); }
      return { results: [], meta: { count: 0, next_cursor: null } };
    });
    const runner = new GraphJobRunner(store, fake.provider);
    const api = await listen(context, { jobStore: store, jobRunner: runner });
    try {
      await new Promise<void>((resolve, reject) => {
        const client = request(`${api.origin}/api/graph-jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, response => {
          try { assert.equal(response.statusCode, 202); response.destroy(); client.destroy(); resolve(); }
          catch (error) { reject(error); }
        });
        client.once('error', reject);
        client.setTimeout(10_000, () => client.destroy(new Error('Submit socket timed out')));
        client.end('{"origins":["W1"]}');
      });
      await entered;
      const id = (await sql.query('SELECT id FROM openpapers.graph_jobs')).rows[0].id;
      const running = await api.get(id);
      assert.equal(running.state, 'running'); assert.equal(running.requestsUsed, 1); assert.equal(running.acquiredCount, 0);
      assert.equal(fake.calls[0].signal.aborted, false);
      release();
      await Promise.all(api.background);
      assert.equal((await api.get(id)).acquiredCount, 1);
      await runner.runBatch(10);
      assert.equal((await api.get(id)).state, 'completed');
    } finally { release(); await Promise.all(api.background); }
  });

  await t.test('provider unavailability pauses durable progress without fabricating or re-fetching a graph', async context => {
    const store = await setup(context);
    const fake = transport(() => new Response('private fixture failure', { status: 503 }));
    const runner = new GraphJobRunner(store, fake.provider);
    const api = await listen(context, { jobStore: store, jobRunner: runner });
    const job = await api.submit(['W1']);
    await Promise.all(api.background);
    const paused = await api.get(job.id);
    assert.equal(paused.state, 'paused'); assert.equal(paused.requestsUsed, 1); assert.equal(paused.acquiredCount, 0);
    assert.equal(paused.result, null); assert.ok(Date.parse(paused.nextRunAt!) > Date.now());
    const checkpoint = (await sql.query('SELECT checkpoint FROM openpapers.graph_jobs WHERE id = $1', [job.id])).rows[0].checkpoint;
    assert.deepEqual(checkpoint.frontier[0], { kind: 'seed', ids: ['W1'], depth: 0, attempts: 1 });
    assert.equal(await runner.runStep(job.id), undefined); assert.equal(fake.calls.length, 1);
  });

  await t.test('exhausted daily quota pauses without another request or cursor advance', async context => {
    const store = await setup(context, { dailyRequestBudget: 1 });
    const fake = transport();
    const runner = new GraphJobRunner(store, fake.provider);
    const job = await store.create(['W1'], 700, 1500);
    await runner.runStep(job.id);
    const before = (await sql.query('SELECT checkpoint FROM openpapers.graph_jobs WHERE id = $1', [job.id])).rows[0].checkpoint;
    const paused = (await runner.runStep(job.id))!;
    assert.equal(paused.state, 'paused'); assert.equal(paused.requestsUsed, 1); assert.equal(paused.acquiredCount, 1);
    assert.ok(Date.parse(paused.nextRunAt!) > Date.now()); assert.equal(fake.calls.length, 1);
    assert.deepEqual((await sql.query('SELECT checkpoint FROM openpapers.graph_jobs WHERE id = $1', [job.id])).rows[0].checkpoint, before);
    assert.equal((await sql.query('SELECT daily_requests FROM openpapers.provider_budget')).rows[0].daily_requests, 1);
  });

  await t.test('stale leases are fenced and a new runner recovers without losing request charges', async context => {
    const store = await setup(context);
    const job = await store.create(['W1'], 700, 1500);
    const claims = await Promise.all([store.claim(job.id), store.claim(job.id)]);
    assert.equal(claims.filter(Boolean).length, 1);
    const stale = claims.find(Boolean)!;
    assert.equal((await store.reserveRequest(stale)).allowed, true);
    const page = { papers: [normalizeWork(work('W1', ['W9', 'W9']))], fetchedAt: new Date().toISOString(),
      checkpoint: stale.checkpoint, requestUsed: false };
    await sql.query(`UPDATE openpapers.graph_jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [job.id]);
    await assert.rejects(store.commit(stale, page), /lease is stale or expired/);
    await assert.rejects(store.reserveRequest(stale), /lease is stale or expired/);
    await assert.rejects(store.papers(stale), /lease is stale or expired/);
    assert.equal((await sql.query('SELECT count(*)::integer AS count FROM openpapers.job_papers')).rows[0].count, 0);
    const fake = transport();
    const runner = new GraphJobRunner(store, fake.provider);
    const recovered = (await runner.runStep(job.id))!;
    assert.equal(recovered.requestsUsed, 2); assert.equal(recovered.acquiredCount, 1);
    await assert.rejects(store.commit(stale, page), /lease is stale or expired/);
    await runner.runBatch(10);
    assert.equal((await store.get(job.id))!.state, 'completed');
    assert.equal((await store.get(job.id))!.requestsUsed, fake.calls.length + 1);
  });

  await t.test('a started job survives closing the app/store and publishes in a fresh OS process using the same DB', async context => {
    const store = await setup(context);
    const fake = transport();
    const api = await listen(context, { jobStore: store, jobRunner: new GraphJobRunner(store, fake.provider) });
    const job = await store.create(['W1'], 700, 1500);
    await new GraphJobRunner(store, fake.provider).runStep(job.id);
    const started = await api.get(job.id);
    assert.equal(started.phase, 'acquire'); assert.equal(started.acquiredCount, 1);
    await api.close(); await store.close();
    const moduleUrl = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
    const script = `
      import assert from 'node:assert/strict';
      import { PostgresGraphJobStore } from ${moduleUrl('./postgres-store.ts')};
      import { GraphJobRunner } from ${moduleUrl('./graph-jobs.ts')};
      import { createApp } from ${moduleUrl('./index.ts')};
      const store = new PostgresGraphJobStore(process.env.GRAPH_TEST_DATABASE_URL, ${JSON.stringify(storeOptions)});
      let calls = 0;
      const provider = { getPaper: async () => { throw new Error('Restart must not replay the committed seed'); },
        request: async (path, params) => {
          assert.equal(path, '/works'); assert.equal(params.filter, 'cites:W1');
          calls++; return { results: [], meta: { count: 0, next_cursor: null } };
        }, metadata: () => ({ source: 'live', fetchedAt: new Date().toISOString() }) };
      const runner = new GraphJobRunner(store, provider);
      let server;
      try {
        await store.ready;
        const before = await store.get(process.env.GRAPH_TEST_JOB_ID);
        assert.equal(before.phase, 'acquire'); assert.equal(before.acquiredCount, 1);
        server = createApp({ offline: true, jobStore: store, jobRunner: runner,
          cacheDirectory: ${JSON.stringify(cacheDirectory)}, distPath: ${JSON.stringify(cacheDirectory)} }).app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const base = 'http://127.0.0.1:' + server.address().port;
        const pending = await fetch(base + '/api/graph-jobs/' + before.id);
        assert.equal(pending.status, 200); assert.equal((await pending.json()).acquiredCount, 1);
        assert.equal((await runner.runBatch(10)).length, 4);
        assert.equal(calls, 2);
        const response = await fetch(base + '/api/graph-jobs/' + before.id);
        assert.equal(response.status, 200);
        process.stdout.write(JSON.stringify({ pid: process.pid, job: await response.json() }));
      } finally {
        if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        await store.close();
      }
    `;
    const child = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script],
      { env: { ...process.env, GRAPH_TEST_JOB_ID: job.id }, timeout: 30_000 });
    const output = JSON.parse(child.stdout);
    assert.notEqual(output.pid, process.pid);
    const completed = GraphJobSchema.parse(output.job);
    assert.equal(completed.id, started.id); assert.equal(completed.state, 'completed'); assert.equal(completed.requestsUsed, 3);
    assert.equal(completed.result!.meta.fetchedAt,
      (await sql.query('SELECT fetched_at FROM openpapers.job_papers WHERE job_id = $1', [job.id])).rows[0].fetched_at.toISOString());
    assert.deepEqual(completed.result!.nodes.map(node => PaperSchema.parse(node)), [normalizeWork(work('W1'))]);
    assert.equal(fake.calls.length, 1);
  });

  await t.test('700 actual records exceed the quick-pool cap, publish pruned positive-evidence edges and fit below 4 MiB', async context => {
    const store = await setup(context);
    const abstract = { ['x'.repeat(199)]: Array.from({ length: 150 }, (_, i) => i) };
    const origin = { ...work('W1', ['W9000', 'W9000', 'W9001']), cited_by_count: 1_000_000, abstract_inverted_index: abstract };
    const candidates = Array.from({ length: 699 }, (_, i) => ({ ...work(`W${i + 10}`, ['W9000', 'W9000', 'W9001', 'W1', 'W1', 'W10', 'W10']),
      abstract_inverted_index: abstract }));
    const fake = transport(url => {
      if (url.pathname === '/works/W1') return origin;
      if (url.searchParams.get('filter') !== 'cites:W1') return { results: [], meta: { count: 0, next_cursor: null } };
      const cursor = url.searchParams.get('cursor')!;
      const start = cursor === '*' ? 0 : Number(cursor.slice('fixture-'.length));
      assert.ok(Number.isInteger(start) && start >= 0 && start < candidates.length);
      return { results: candidates.slice(start, start + 100), meta: { count: 1_000_000,
        next_cursor: start + 100 < candidates.length ? `fixture-${start + 100}` : null } };
    });
    const runner = new GraphJobRunner(store, fake.provider, { maxResponseBytes: 200_000 });
    const api = await listen(context, { jobStore: store, jobRunner: runner });
    const job = await api.submit(['W1']);
    await Promise.all(api.background);
    const steps = await runner.runBatch(100);
    assert.ok(steps.length < 100);
    const completed = await api.get(job.id);
    assert.equal(completed.state, 'completed', completed.error ?? undefined);
    assert.equal(completed.acquiredCount, 700); assert.equal(completed.stopReason, 'candidate_budget');
    const graph = GraphResponseSchema.parse(completed.result);
    assert.equal(graph.meta.candidateCount, 700); assert.equal(graph.meta.candidateBudget, 700);
    assert.equal(graph.meta.referenceCount, completed.referenceCount); assert.equal(graph.meta.jobId, job.id);
    assert.equal(graph.meta.acquisitionStop, 'candidate_budget'); assert.equal(graph.meta.provider, 'openalex');
    assert.match(graph.meta.coverage, /700\/700/); assert.match(graph.meta.warning!, /sample-local/);
    assert.match(graph.meta.warning!, /abstracts were shortened/);
    assert.equal(graph.nodes.length, 40); assert.ok(graph.edges.length > 0 && graph.edges.length < 780);
    const rows = await sql.query(`SELECT p.id, p.metadata, coalesce((SELECT array_agg(r.target ORDER BY r.target)
      FROM openpapers.job_references r WHERE r.job_id = p.job_id AND r.source = p.id), '{}'::text[]) AS references
      FROM openpapers.job_papers p WHERE p.job_id = $1 ORDER BY p.id`, [job.id]);
    const papers = rows.rows.map(row => PaperSchema.parse({ ...row.metadata, id: row.id, references: row.references }));
    assert.equal(papers.length, 700);
    assert.equal(papers.reduce((sum, paper) => sum + paper.references.length, 0), completed.referenceCount);
    const evidence = verifyEvidence(graph, papers);
    const pair = graph.edges.find(edge => [edge.source, edge.target].sort().join(',') === 'W1,W10');
    assert.ok(pair); assert.equal(pair.coCitations, 698); assert.equal(evidence('W1', 'W10').co, 698);
    assert.equal(graph.nodes.find(paper => paper.isOrigin)!.abstract, normalizeWork(origin).abstract);
    assert.ok(papers.every(paper => paper.abstract.length === 29999), 'Projection shortening must not rewrite source metadata');
    assert.ok([...graph.nodes, ...graph.prior, ...graph.derivative].filter(paper => !paper.isOrigin).every(paper => paper.abstract.length === 1000));
    const reached = new Set([graph.origins[0]]);
    for (let i = 0; i < graph.nodes.length; i++) for (const edge of graph.edges) {
      if (reached.has(edge.source) || reached.has(edge.target)) { reached.add(edge.source); reached.add(edge.target); }
    }
    assert.equal(reached.size, graph.nodes.length, 'Edge pruning must preserve connectivity');
    const bytes = Buffer.byteLength(JSON.stringify(completed));
    const persistedBytes = (await sql.query('SELECT octet_length(result::text) AS bytes FROM openpapers.graph_jobs WHERE id = $1', [job.id])).rows[0].bytes;
    assert.ok(bytes < 4 * 1024 * 1024); assert.ok(persistedBytes < 4 * 1024 * 1024);
    assert.equal(fake.calls.length, completed.requestsUsed);
    context.diagnostic(`700 stored candidates / ${completed.referenceCount} distinct reference rows / ${completed.requestsUsed} requests; ${graph.nodes.length} nodes / ${graph.edges.length} edges; HTTP envelope ${bytes} bytes; SQL JSONB result ${persistedBytes} bytes.`);
  });

  await t.test('distinct unrelated origins and identical topics produce zero invented edges', async context => {
    const store = await setup(context);
    const fake = transport(url => work(url.pathname.slice(7), [`W${Number(url.pathname.slice(8)) + 100}`]));
    const runner = new GraphJobRunner(store, fake.provider);
    const job = await store.create(['W3', 'W2', 'W1'], 40, 3);
    await runner.runBatch(4);
    const completed = (await store.get(job.id))!;
    assert.equal(completed.state, 'completed'); assert.equal(completed.acquiredCount, 3);
    assert.deepEqual(completed.result!.origins, ['W1', 'W2', 'W3']);
    assert.equal(completed.result!.nodes.length, 3); assert.deepEqual(completed.result!.edges, []);
    assert.match(completed.result!.meta.warning!, /no artificial edges/);
    assert.equal(fake.calls.length, 3);
  });
});
