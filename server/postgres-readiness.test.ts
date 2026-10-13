import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import { createApp } from './index.ts';
import { PostgresGraphStore } from './postgres-store.ts';

const databaseUrl = 'postgresql://postgres:readiness-dummy-secret@localhost/readiness_unused';
const migrated = { command: 'SELECT', rowCount: 1, oid: 0, fields: [], rows: [{ present: true }] };

async function configApi(t: TestContext, jobStore?: PostgresGraphStore) {
  const unused = `/tmp/opencode/postgres-readiness-unused-${randomUUID()}`;
  const { app, service } = createApp({ jobStore, offline: true, defaultProvider: 'openalex',
    cacheDirectory: unused, distPath: unused });
  await service.ready;
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return async () => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/graph-jobs/config`,
      { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.text();
    assert.ok(!body.includes('readiness-dummy-secret'));
    assert.ok(!body.includes('postgresql://'));
    return JSON.parse(body);
  };
}

// Mock only the driver query: stores retain a real Pool, but never open PostgreSQL sockets.
test('readiness retries on the next call after the connection recovers', async t => {
  const failure = new Error('Connection terminated due to connection timeout');
  let recovered = false;
  const query = t.mock.method(pg.Pool.prototype, 'query', (async () => {
    if (!recovered) throw failure;
    return migrated;
  }) as typeof pg.Pool.prototype.query);
  const store = new PostgresGraphStore(databaseUrl);
  t.after(() => store.close());

  await assert.rejects(store.ready, error => error === failure);
  assert.equal(query.mock.callCount(), 1);
  recovered = true;
  await store.ready;
  assert.equal(query.mock.callCount(), 2);
  await store.ready;
  assert.equal(query.mock.callCount(), 2, 'Successful readiness stays cached');
});

test('construction is lazy and concurrent first reads share one successful check', async t => {
  let resolve!: (result: typeof migrated) => void;
  const pending = new Promise<typeof migrated>(done => { resolve = done; });
  const query = t.mock.method(pg.Pool.prototype, 'query', (() => pending) as typeof pg.Pool.prototype.query);
  const store = new PostgresGraphStore(databaseUrl);
  t.after(async () => { resolve(migrated); await store.close(); });
  assert.equal(query.mock.callCount(), 0);

  const first = store.ready;
  const second = store.ready;
  assert.equal(first, second);
  assert.equal(query.mock.callCount(), 1);
  resolve(migrated);
  await Promise.all([first, second]);
  assert.equal(store.ready, first);
  assert.equal(query.mock.callCount(), 1);
});

test('closing an unused store ends its pool once without checking readiness', async t => {
  const query = t.mock.method(pg.Pool.prototype, 'query', (async () => migrated) as typeof pg.Pool.prototype.query);
  const end = t.mock.method(pg.Pool.prototype, 'end');
  const store = new PostgresGraphStore(databaseUrl);
  t.after(() => store.close());
  const first = store.close();
  assert.equal(store.close(), first);
  await assert.rejects(store.ready, /store is closed/);
  await first;
  await assert.rejects(store.ready, /store is closed/);
  assert.equal(query.mock.callCount(), 0);
  assert.equal(end.mock.callCount(), 1);
});

test('concurrent failed checks share the rejection without retrying until the next read', async t => {
  let reject!: (error: Error) => void;
  const pending = new Promise<typeof migrated>((_resolve, fail) => { reject = fail; });
  const query = t.mock.method(pg.Pool.prototype, 'query', (() => pending) as typeof pg.Pool.prototype.query);
  const store = new PostgresGraphStore(databaseUrl);
  const failure = new Error('Connection timeout');
  t.after(async () => { reject(failure); await store.close(); });
  const first = store.ready;
  const second = store.ready;
  assert.equal(first, second);
  const rejected = Promise.all([assert.rejects(first, error => error === failure),
    assert.rejects(second, error => error === failure)]);
  reject(failure);
  await rejected;
  assert.equal(query.mock.callCount(), 1);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(query.mock.callCount(), 1, 'No background retry');
  await assert.rejects(store.ready, error => error === failure);
  assert.equal(query.mock.callCount(), 2);
});

test('close drains an existing readiness check even when it fails, without starting another', async t => {
  let reject!: (error: Error) => void;
  const pending = new Promise<typeof migrated>((_resolve, fail) => { reject = fail; });
  const query = t.mock.method(pg.Pool.prototype, 'query', (() => pending) as typeof pg.Pool.prototype.query);
  const end = t.mock.method(pg.Pool.prototype, 'end');
  const store = new PostgresGraphStore(databaseUrl);
  const failure = new Error('Connection timeout');
  t.after(async () => { reject(failure); await store.close(); });
  const rejected = assert.rejects(store.ready, error => error === failure);
  const closing = store.close();
  assert.equal(store.close(), closing);
  await assert.rejects(store.ready, /store is closed/);
  assert.equal(end.mock.callCount(), 0);
  reject(failure);
  await rejected;
  await closing;
  await assert.rejects(store.ready, /store is closed/);
  assert.equal(query.mock.callCount(), 1);
  assert.equal(end.mock.callCount(), 1);
});

test('missing or incomplete migrations are checked again and keep rejecting without creating anything', async t => {
  let rows: { present: boolean }[] = [];
  const query = t.mock.method(pg.Pool.prototype, 'query', (async () => ({ ...migrated, rows })) as typeof pg.Pool.prototype.query);
  const store = new PostgresGraphStore(databaseUrl);
  t.after(() => store.close());
  for (rows of [[], [{ present: false }]]) {
    await assert.rejects(store.ready, /Graph database migration is missing/);
    await assert.rejects(store.ready, /Graph database migration is missing/);
  }
  assert.equal(query.mock.callCount(), 4);
  for (const call of query.mock.calls) {
    assert.match(String(call.arguments[0]), /^SELECT version,/);
    assert.deepEqual(call.arguments[1], ['202610140001_graph_jobs']);
  }
});

test('app composition starts no readiness query and config initiates the first check', async t => {
  const query = t.mock.method(pg.Pool.prototype, 'query', (async () => migrated) as typeof pg.Pool.prototype.query);
  const store = new PostgresGraphStore(databaseUrl);
  t.after(() => store.close());
  const config = await configApi(t, store);
  assert.equal(query.mock.callCount(), 0);
  assert.equal((await config()).available, true);
  assert.equal(query.mock.callCount(), 1);
});

test('config recovers from a failed connection on the next HTTP request without leaking credentials', async t => {
  const log = t.mock.method(console, 'error', () => {});
  const failure = Object.assign(new Error(`Connection terminated: ${databaseUrl}`), { code: 'ETIMEDOUT' });
  let attempts = 0;
  const query = t.mock.method(pg.Pool.prototype, 'query', (async () => {
    if (++attempts === 1) throw failure;
    return migrated;
  }) as typeof pg.Pool.prototype.query);
  const store = new PostgresGraphStore(databaseUrl);
  t.after(() => store.close());
  const config = await configApi(t, store);

  const first = await config();
  assert.equal(first.available, false);
  assert.equal(first.persistence, 'none');
  const second = await config();
  assert.equal(second.available, true);
  assert.equal(second.persistence, 'postgres');
  assert.equal(query.mock.callCount(), 2);
  assert.deepEqual(log.mock.calls.map(call => call.arguments), [['Graph database readiness failed:', 'ETIMEDOUT']]);
});

test('authentication errors remain failures on every check and config logs only their code', async t => {
  const log = t.mock.method(console, 'error', () => {});
  const failure = Object.assign(new Error(`password authentication failed: ${databaseUrl}`), { code: '28P01' });
  const query = t.mock.method(pg.Pool.prototype, 'query', (async () => { throw failure; }) as typeof pg.Pool.prototype.query);
  const store = new PostgresGraphStore(databaseUrl);
  t.after(() => store.close());
  await assert.rejects(store.ready, error => error === failure);
  await assert.rejects(store.ready, error => error === failure);
  const config = await configApi(t, store);
  for (let i = 0; i < 2; i++) {
    const body = await config();
    assert.equal(body.available, false);
    assert.equal(body.persistence, 'none');
  }
  assert.equal(query.mock.callCount(), 4);
  assert.deepEqual(log.mock.calls.map(call => call.arguments), Array(2).fill(['Graph database readiness failed:', '28P01']));
});

test('config never logs arbitrary error messages, stacks, names, codes or thrown values', async t => {
  const log = t.mock.method(console, 'error', () => {});
  let failure: unknown;
  t.mock.method(pg.Pool.prototype, 'query', (async () => { throw failure; }) as typeof pg.Pool.prototype.query);
  const store = new PostgresGraphStore(databaseUrl);
  t.after(() => store.close());
  const config = await configApi(t, store);
  for (failure of [new Error(databaseUrl), Object.assign(new Error(databaseUrl), { code: databaseUrl }),
    Object.assign(new Error(databaseUrl), { code: databaseUrl, name: databaseUrl }), databaseUrl]) {
    assert.equal((await config()).available, false);
  }
  assert.deepEqual(log.mock.calls.map(call => call.arguments), ['Error', 'Error', 'UnknownError', 'UnknownError']
    .map(name => ['Graph database readiness failed:', name]));
});

test('normally unconfigured or offline config returns none without warnings', async t => {
  const warn = t.mock.method(console, 'warn', () => {});
  const error = t.mock.method(console, 'error', () => {});
  const query = t.mock.method(pg.Pool.prototype, 'query', (async () => migrated) as typeof pg.Pool.prototype.query);
  const config = await configApi(t);
  for (let i = 0; i < 2; i++) {
    const body = await config();
    assert.equal(body.available, false);
    assert.equal(body.persistence, 'none');
  }
  assert.equal(query.mock.callCount(), 0);
  assert.equal(warn.mock.callCount(), 0);
  assert.equal(error.mock.callCount(), 0);
});
