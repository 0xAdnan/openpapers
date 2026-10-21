import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './index.ts';

test('Vercel rewrite metadata does not become a benchmark filter; other unknown filters remain invalid', async t => {
  const previous = process.env.VERCEL;
  process.env.VERCEL = '1';
  t.after(() => { if (previous === undefined) delete process.env.VERCEL; else process.env.VERCEL = previous; });
  const directory = await mkdtemp(join(tmpdir(), 'openpapers-rewrite-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { app } = createApp({ offline: true, cacheDirectory: directory });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${origin}/api/benchmarks/papers?q=Defects4J&path=benchmarks/papers`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).benchmark.name, 'Defects4J');
  for (const extra of ['unknown=value', 'path=other', 'q=another']) {
    const invalid = await fetch(`${origin}/api/benchmarks/papers?q=Defects4J&${extra}`);
    assert.equal(invalid.status, 400);
  }
});

test('serverless cache path and snapshot override serve bundled API and bound serialized responses', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'openpapers-deployment-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { offline: true, cacheDirectory: directory, snapshotPath: fileURLToPath(new URL('../data/snapshot.json', import.meta.url)), maxResponseBytes: 4 * 1024 * 1024 };
  const { app, service } = createApp(options);
  await service.ready;
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const examples = await service.examples();
  for (const example of examples) {
    const response = await fetch(`${origin}/api/graph?ids=${example.id}`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(Buffer.byteLength(body) < options.maxResponseBytes);
    assert.equal(JSON.parse(body).nodes.length, 40);
  }
  assert.ok((await readFile(join(directory, 'openalex-cache-v1.json'), 'utf8')).includes('graph:'));
  service.search = async () => ({ results: [], total: 0, page: 1, perPage: 20,
    meta: { source: 'cache', fetchedAt: new Date().toISOString(), warning: 'x'.repeat(options.maxResponseBytes + 1) } });
  const oversized = await fetch(`${origin}/api/search?q=test`);
  assert.equal(oversized.status, 413);
  assert.match((await oversized.json()).error, /deployment response limit/);
  const unknown = await fetch(`${origin}/api/unknown`, { headers: { Accept: 'text/html' } });
  assert.equal(unknown.status, 404);
  assert.match(unknown.headers.get('content-type')!, /application\/json/);
});
