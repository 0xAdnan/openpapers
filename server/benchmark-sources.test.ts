import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { BenchmarkSources, documentLinks, verifiedArtifact } from './benchmark-sources.ts';
import { BenchmarkService } from './benchmarks.ts';
import { PaperService } from './service.ts';
import { PersistentCache } from './cache.ts';
import { discoverBenchmarks } from '../shared/benchmark-discovery.ts';
import { PaperBenchmarksResponseSchema } from '../shared/benchmarks.ts';
import type { Paper } from '../shared/types.ts';

const paper: Paper = { id: 'W99123', title: 'Synthetic source discovery research', authors: ['Alice Researcher'],
  year: 2026, venue: 'Synthetic venue', citations: 0, references: [], abstract: 'We evaluate on 23 real-world web repositories.',
  doi: 'https://doi.org/10.1234/source', url: 'https://doi.org/10.1234/source', pdfUrl: 'https://publisher.example/paper.pdf', openAccess: true, topics: [] };
const record = { id: '10.1234/artifact', attributes: { titles: [{ title: `${paper.title} — Artifact` }], creators: [{ name: 'Researcher, Alice' }],
  relatedIdentifiers: [{ relatedIdentifierType: 'URL', relationType: 'IsSupplementedBy', relatedIdentifier: 'https://github.com/synthetic-author/synthetic-suite' }],
  descriptions: [{ description: 'This artifact includes 23 real-world web repositories.\n\nWe use the NebulaBench dataset.' }] } };
const text = `${paper.title}\nAlice Researcher\n10.1234/source\n\f\n4 Evaluation\n\n4.1 Evaluation setup\n\nWe evaluate on NebulaBench and AuroraSet benchmarks.\n\nWe use 4 Orbit, 8 Comet and 11 Lunar repositories.\n\nReferences\n\n[1] UnusedBench dataset.`;
const encode = (value: unknown) => new Uint8Array(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));
async function setup(t: test.TestContext, overrides: ConstructorParameters<typeof BenchmarkSources>[1] = {}) {
  const dir = await mkdtemp('/tmp/opencode/benchmark-sources-test-'); t.after(() => rm(dir, { recursive: true, force: true }));
  const cache = new PersistentCache(dir); const calls: string[] = [];
  const sources = new BenchmarkSources(cache, { download: async url => {
    calls.push(url.href);
    if (url.hostname === 'api.crossref.org') return encode({ message: { DOI: paper.doi, title: [paper.title], link: [] } });
    if (url.hostname === 'api.datacite.org') return encode({ data: [record] });
    if (url.pathname.endsWith('/readme')) return encode({ content: Buffer.from(`# ${paper.title}\n\nThis artifact includes 23 real-world web repositories.`).toString('base64'), encoding: 'base64', download_url: 'https://raw.githubusercontent.com/synthetic-author/synthetic-suite/main/README.md' });
    if (url.pathname.endsWith('/contents/')) return encode([{ name: 'manuscript.pdf', type: 'file', download_url: 'https://raw.githubusercontent.com/synthetic-author/synthetic-suite/main/manuscript.pdf' }]);
    throw new Error('Unexpected source');
  }, downloadPdf: async url => { calls.push(url.href); return encode('%PDF-synthetic'); }, extract: async () => text, ...overrides });
  return { cache, dir, calls, sources };
}

test('new names, quoted lowercase datasets and custom counted suites are discovered without a name registry', () => {
  for (let n = 1; n <= 10; n++) {
    const result = discoverBenchmarks({ kind: 'abstract', text: `We evaluate on FreshBench${n} and NovelSet${n} benchmarks.`, url: paper.url });
    assert.deepEqual(result.map(b => b.name), [`FreshBench${n}`, `NovelSet${n}`]);
    assert.ok(result.every(b => b.url === null));
  }
  assert.equal(discoverBenchmarks({ kind: 'abstract', text: 'We use a dataset called "unseen corpus".', url: paper.url })[0].name, 'unseen corpus');
  const suites = discoverBenchmarks({ kind: 'fulltext', text, url: paper.url }).filter(b => b.category === 'suite');
  assert.deepEqual(suites.map(b => b.name).sort(), ['11 Lunar repositories', '4 Orbit repositories', '8 Comet repositories']);
  const different = discoverBenchmarks({ kind: 'abstract', text: 'We use 10 training projects and 10 testing projects.', url: paper.url });
  assert.deepEqual(different.map(b => b.name), ['10 training projects', '10 testing projects']);
});

test('related work, bibliography, negation, framework qualifiers and code are not benchmark evidence', () => {
  for (const input of ['We do not use any benchmarks.', 'Future work will evaluate on GhostBench benchmark.',
    '2 Related work\nOther authors use GhostBench dataset.\n\n3 Conclusion', 'References\n[1] We use GhostBench dataset.',
    '```\n15 Platform benchmark repositories — 165 MB benchmarks/data/\n```']) {
    assert.deepEqual(discoverBenchmarks({ kind: 'fulltext', text: input, url: paper.url }), [], input);
  }
  const result = discoverBenchmarks({ kind: 'artifact', text: 'This artifact includes 15 Platform benchmark repositories from the NebulaBench dataset.', url: paper.url });
  assert.deepEqual(result.map(b => b.name), ['15 Platform benchmark repositories', 'NebulaBench']);
});

test('artifact matching requires exact paper title and author or an explicit DOI supplement relation', () => {
  assert.equal(verifiedArtifact(record, paper), true);
  assert.equal(verifiedArtifact({ ...record, attributes: { ...record.attributes, creators: [{ name: 'Different Author' }] } }, paper), false);
  assert.equal(verifiedArtifact({ ...record, attributes: { ...record.attributes, titles: [{ title: `${paper.title} unrelated study` }] } }, paper), false);
  assert.equal(verifiedArtifact({ ...record, attributes: { ...record.attributes, titles: [{ title: 'Different artifact' }], creators: [], relatedIdentifiers: [{ relationType: 'IsSupplementTo', relatedIdentifierType: 'DOI', relatedIdentifier: paper.doi }] } }, paper), true);
  assert.equal(verifiedArtifact({ ...record, attributes: { ...record.attributes, titles: [], creators: [], relatedIdentifiers: [{ relationType: 'References', relatedIdentifierType: 'DOI', relatedIdentifier: paper.doi }] } }, paper), false);
});

test('source discovery verifies metadata, artifact README and linked PDFs; caches raw sources across restarts', async t => {
  const f = await setup(t); const service = new PaperService(f.cache, false); await service.ready;
  const benchmarks = new BenchmarkService(service, { sources: f.sources });
  const response = { paper, meta: { provider: 'openalex' as const, source: 'live' as const, fetchedAt: new Date().toISOString() } };
  const results = await Promise.all(Array.from({ length: 5 }, () => benchmarks.inPaper(response)));
  assert.ok(results.every(r => r.coverage.fields.includes('fulltext')));
  assert.equal(f.calls.length, 5, 'one shared request: Crossref, DataCite, README, files, PDF');
  assert.equal(results[0].coverage.discovery.status, 'complete');
  assert.ok(results[0].benchmarks.some(b => b.name === 'AuroraSet' && b.evidence.kind === 'fulltext'));
  assert.ok(results[0].benchmarks.some(b => b.category === 'suite' && b.url === 'https://github.com/synthetic-author/synthetic-suite'));
  assert.ok(results[0].coverage.discovery.sources.filter(s => s.status === 'read').every(s => s.sha256 && s.fetchedAt));
  assert.ok(PaperBenchmarksResponseSchema.safeParse(results[0]).success);
  const offline = new BenchmarkService(new PaperService(new PersistentCache(f.dir), true));
  assert.deepEqual((await offline.inPaper(response)).benchmarks, results[0].benchmarks);
  const changed = await benchmarks.inPaper({ ...response, paper: { ...paper, abstract: 'Changed abstract.' } });
  assert.ok(changed.coverage.fields.includes('fulltext'));
  assert.equal(f.calls.length, 5, 'raw sources keep their original six-hour freshness');
});

test('mismatched PDF/title/DOI and unrelated artifact search hits produce no invented results', async t => {
  for (const wrong of [text.replace(paper.title, 'Wrong paper'), text.replace('10.1234/source', '10.1234/wrong')]) {
    const f = await setup(t, { download: async url => url.hostname === 'api.datacite.org' ? encode({ data: [{ ...record, attributes: { ...record.attributes, creators: [] } }] }) : encode({ message: { DOI: '10.1234/wrong', title: [paper.title], link: [] } }), extract: async () => wrong });
    const result = await f.sources.discover({ ...paper, abstract: '' }, AbortSignal.timeout(1000));
    assert.deepEqual(result.benchmarks, []);
    assert.ok(!result.coverage.fields.includes('fulltext'));
    assert.equal(result.coverage.discovery.sources.find(s => s.kind === 'fulltext')?.status, 'rejected');
  }
});

test('offline mode never fetches, unavailable sources preserve metadata candidates and retry briefly', async t => {
  const f = await setup(t, { download: async () => { throw new Error('Outage'); }, downloadPdf: async () => { throw new Error('Outage'); } });
  const offline = await f.sources.discover(paper, AbortSignal.timeout(1000), true);
  assert.deepEqual(offline.coverage.fields, ['title', 'abstract']); assert.deepEqual(f.calls, []);
  const service = new PaperService(f.cache, false); await service.ready;
  const benchmarks = new BenchmarkService(service, { sources: f.sources });
  const result = await benchmarks.inPaper({ paper, meta: { source: 'live', provider: 'openalex', fetchedAt: new Date().toISOString() } });
  assert.equal(result.benchmarks[0].name, '23 real-world web repositories');
  assert.equal(result.coverage.discovery.status, 'unavailable');
  assert.ok((await f.cache.list('paper-benchmarks:')).every(e => e.expiresAt <= Date.now() + 31000));
});

test('discovery deadline retains metadata and client cancellation does not store a derived result', async t => {
  const f = await setup(t, { download: async (_url, signal) => { await delay(1000, undefined, { signal }); throw new Error('unreachable'); }, downloadPdf: async (_url, signal) => { await delay(1000, undefined, { signal }); throw new Error('unreachable'); } });
  const service = new PaperService(f.cache, false); await service.ready;
  const response = { paper, meta: { source: 'live' as const, provider: 'openalex' as const, fetchedAt: new Date().toISOString() } };
  const bounded = new BenchmarkService(service, { sources: f.sources, timeoutMs: 30 });
  const result = await bounded.inPaper(response); assert.equal(result.benchmarks.length, 1);
  const controller = new AbortController();
  const pending = bounded.inPaper({ ...response, paper: { ...paper, title: `${paper.title} changed` } }, controller.signal);
  const rejected = assert.rejects(pending, /Navigation/); controller.abort(new Error('Navigation')); await rejected;
  assert.equal((await f.cache.list('paper-benchmarks:')).length, 1);
});

test('one cancelled consumer leaves shared source discovery running for the other', async t => {
  let enter!: () => void; const entered = new Promise<void>(r => { enter = r; });
  const f = await setup(t, { download: async (_url, signal) => { enter(); await delay(50, undefined, { signal }); return encode({ data: [] }); }, downloadPdf: async () => { throw new Error('No PDF'); } });
  const service = new PaperService(f.cache, false); await service.ready;
  const benchmarks = new BenchmarkService(service, { sources: f.sources });
  const response = { paper, meta: { source: 'live' as const, provider: 'openalex' as const, fetchedAt: new Date().toISOString() } };
  const controller = new AbortController(); const a = benchmarks.inPaper(response, controller.signal), b = benchmarks.inPaper(response);
  const rejected = assert.rejects(a, /Navigation/); await entered; controller.abort(new Error('Navigation')); await rejected;
  assert.equal((await b).benchmarks.length, 1);
});

test('document links retain relative author files but exclude private endpoints and unsafe schemes', () => {
  const links = documentLinks('[paper](paper.pdf) https://127.0.0.1/private <a href="javascript:alert(1)">bad</a>', 'https://raw.githubusercontent.com/author/repo/main/README.md');
  assert.deepEqual(links.map(url => url.href), ['https://raw.githubusercontent.com/author/repo/main/paper.pdf']);
});
