import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { GraphResponseSchema } from '../shared/schemas.ts';
import type { GraphResponse, Paper } from '../shared/types.ts';
import { PersistentCache } from './cache.ts';
import { ALGORITHM } from './graph.ts';
import { GraphFallbackCoordinator, graphCoverage } from './graph-fallback.ts';
import { OpenAlexProvider, type OpenAlexWork } from './openalex.ts';
import { normalizeSemanticPaper, S2_LICENSE_WARNING, SemanticScholarError, type SemanticPaper } from './semantic-scholar.ts';
import { SemanticService } from './semantic-service.ts';
import { ApiError, PaperService } from './service.ts';

const sha = (n: number) => n.toString(16).padStart(40, '0');
const s2id = (n: number) => `S2:${sha(n)}`;
const date = '2026-10-19T00:00:00.000Z';
const rawPaper = (n = 1, changes: Partial<SemanticPaper> = {}): SemanticPaper => ({ paperId: sha(n),
  title: 'Synthetic identity fixture', year: 2026, authors: [{ name: 'Fixture Author' }],
  externalIds: { DOI: '10.1234/fixture' }, ...changes });
const s2paper = (n = 1, changes: Partial<SemanticPaper> = {}) => normalizeSemanticPaper(rawPaper(n, changes));
const oaPaper = (n = 1, changes: Partial<Paper> = {}): Paper => ({ ...s2paper(n), id: `W${n}`,
  url: `https://openalex.org/W${n}`, references: [], ...changes });

function graph(papers: Paper[], origins = [papers[0].id], links = papers.slice(1).map(p => [origins[0], p.id])): GraphResponse {
  return { origins, nodes: papers.map(p => ({ ...p, isOrigin: origins.includes(p.id), similarity: 0,
    sharedReferences: 0, coCitations: 0, graphConnections: 0 })),
  edges: links.map(([source, target]) => ({ source, target, weight: 0, sharedReferences: 0, coCitations: 0, directCitation: true })),
  prior: [], derivative: [], meta: { provider: papers[0].id.startsWith('S2:') ? 'semantic-scholar' : 'openalex',
    source: 'cache', fetchedAt: date, candidateCount: papers.length, algorithm: 'fixture', coverage: 'Synthetic fixture coverage.' } };
}

type OA = ConstructorParameters<typeof GraphFallbackCoordinator>[0];
type S2 = ConstructorParameters<typeof GraphFallbackCoordinator>[1];
function setup(options: { origin?: Paper; original?: GraphResponse; alternative?: GraphResponse;
  results?: Paper[]; raw?: SemanticPaper; enabled?: boolean } = {}) {
  const origin = options.origin ?? oaPaper();
  const original = options.original ?? graph([origin]);
  const alternative = options.alternative ?? graph([s2paper(), s2paper(2), s2paper(3), s2paper(4)]);
  const calls = { oaGraph: [] as string[][], oaPaper: [] as string[], search: [] as [string, number][],
    raw: [] as string[], s2Graph: [] as string[][], signals: [] as (AbortSignal | undefined)[] };
  const handlers: { oaGraph: OA['graph']; oaPaper: OA['paper']; search: S2['search']; raw: S2['provider']['getPaper']; s2Graph: S2['graph'] } = {
    oaGraph: async () => original,
    oaPaper: async id => ({ paper: id === origin.id ? origin : oaPaper(Number(id.slice(1))), meta: original.meta }),
    search: async (_q, page) => ({ results: options.results ?? [s2paper()], page, perPage: 20,
      total: 1, meta: alternative.meta }),
    raw: async () => options.raw ?? rawPaper(1, { externalIds: { ArXiv: '2609.31142' } }),
    s2Graph: async () => alternative,
  };
  const openalex: OA = {
    graph: async (ids, signal) => { calls.oaGraph.push([...ids]); calls.signals.push(signal); return handlers.oaGraph(ids, signal); },
    paper: async (id, signal) => { calls.oaPaper.push(id); calls.signals.push(signal); return handlers.oaPaper(id, signal); },
  };
  const semantic: S2 = {
    search: async (q, page, signal) => { calls.search.push([q, page]); calls.signals.push(signal); return handlers.search(q, page, signal); },
    provider: { getPaper: async (id, signal) => { calls.raw.push(id); calls.signals.push(signal); return handlers.raw(id, signal); } },
    graph: async (ids, signal) => { calls.s2Graph.push([...ids]); calls.signals.push(signal); return handlers.s2Graph(ids, signal); },
  };
  return { origin, original, alternative, calls, handlers, openalex, semantic,
    coordinator: new GraphFallbackCoordinator(openalex, semantic, options.enabled ?? true) };
}

function noSemanticCalls(calls: ReturnType<typeof setup>['calls']) {
  assert.deepEqual([calls.search, calls.raw, calls.s2Graph], [[], [], []]);
}

test('fallback is disabled by default, even for sparse graphs', async () => {
  const f = setup();
  assert.strictEqual(await new GraphFallbackCoordinator(f.openalex, f.semantic).graph(['W1']), f.original);
  assert.deepEqual(f.calls.oaGraph, [['W1']]);
  noSemanticCalls(f.calls);
});

test('disabled fallback preserves the original outage error without identity lookups', async () => {
  const f = setup({ enabled: false }), error = new ApiError(503, 'Original outage');
  f.handlers.oaGraph = async () => { throw error; };
  await assert.rejects(f.coordinator.graph(['W1']), e => e === error);
  assert.deepEqual(f.calls.oaPaper, []);
  noSemanticCalls(f.calls);
});

test('healthy OA graph makes exactly one OA graph call and no other calls', async () => {
  const original = graph([oaPaper(), oaPaper(2), oaPaper(3), oaPaper(4)]), f = setup({ original });
  assert.strictEqual(await f.coordinator.graph(['W1']), original);
  assert.deepEqual(f.calls.oaGraph, [['W1']]);
  assert.deepEqual(f.calls.oaPaper, []);
  noSemanticCalls(f.calls);
});

test('optional fallback has a short deadline, cancels real work and cools down repeated sparse requests', async () => {
  const f = setup();
  let active = 0;
  f.handlers.search = async (_q, _page, signal) => {
    active++;
    try { await delay(10000, undefined, { signal }); }
    finally { active--; }
    throw new Error('unreachable');
  };
  const coordinator = new GraphFallbackCoordinator(f.openalex, f.semantic, true, { timeoutMs: 30 });
  const start = Date.now();
  assert.strictEqual(await coordinator.graph(['W1']), f.original);
  assert.ok(Date.now() - start < 500);
  assert.equal(active, 0);
  assert.strictEqual(await coordinator.graph(['W1']), f.original);
  assert.equal(f.calls.search.length, 1, 'do not retry a slow optional provider on every graph visit');
});

test('successful fallback reuses resolved identity until the original graph changes', async () => {
  const f = setup();
  const first = await f.coordinator.graph(['W1']);
  assert.equal((await f.coordinator.graph(['W1'])).meta.provider, 'semantic-scholar');
  assert.equal(f.calls.search.length, 1);
  assert.equal(f.calls.s2Graph.length, 1);
  f.handlers.oaGraph = async () => ({ ...f.original, meta: { ...f.original.meta, fetchedAt: new Date().toISOString() } });
  await f.coordinator.graph(['W1']);
  assert.equal(f.calls.search.length, 2, 'changed input coverage must not reuse the old comparison');
  assert.equal(first.meta.source, 'cache');
});

for (const size of [1, 2, 3]) test(`OA with ${size} displayed nodes is eligible, even with edges`, async () => {
  const f = setup({ original: graph(Array.from({ length: size }, (_, i) => oaPaper(i + 1))) });
  const response = await f.coordinator.graph(['W1']);
  assert.equal(response.meta.provider, 'semantic-scholar');
  assert.deepEqual(f.calls.search, [[f.origin.doi!, 1]]);
  assert.deepEqual(f.calls.oaPaper, []);
  assert.deepEqual(f.calls.s2Graph, [[s2id(1)]]);
});

test('more than three nodes but no edges is eligible', async () => {
  const f = setup({ original: graph([oaPaper(), oaPaper(2), oaPaper(3), oaPaper(4)], ['W1'], []) });
  assert.equal((await f.coordinator.graph(['W1'])).meta.provider, 'semantic-scholar');
});

test('fallback returns a complete S2 namespace, comparisons and only the native S2 warning without mutation', async () => {
  const f = setup();
  f.original.meta.warning = 'Native OA warning.';
  f.alternative.meta.warning = 'Native S2 licensing warning.';
  f.alternative.prior = [f.alternative.nodes[1]];
  f.alternative.derivative = [f.alternative.nodes[2]];
  const before = structuredClone([f.original, f.alternative]);
  const response = await f.coordinator.graph(['W1']);
  assert.equal(GraphResponseSchema.safeParse(response).success, true);
  assert.deepEqual(response.origins, [s2id(1)]);
  assert.strictEqual(response.nodes, f.alternative.nodes);
  assert.strictEqual(response.edges, f.alternative.edges);
  assert.strictEqual(response.prior, f.alternative.prior);
  assert.strictEqual(response.derivative, f.alternative.derivative);
  assert.equal(response.meta.source, 'cache');
  assert.equal(response.meta.fetchedAt, date);
  assert.deepEqual(response.meta.fallback, { from: 'openalex', requestedOrigins: ['W1'], resolvedOrigins: [s2id(1)],
    reason: 'limited_connections', comparison: { openalex: { nodes: 1, edges: 0, connectedOrigins: 0, candidates: 1 },
      semanticScholar: { nodes: 4, edges: 3, connectedOrigins: 1, candidates: 4 } } });
  assert.match(response.meta.warning!, /Native S2 licensing warning.*OpenAlex has limited.*missing references, abstracts, and indexing gaps/);
  assert.doesNotMatch(response.meta.warning!, /Native OA warning/);
  assert.deepEqual([f.original, f.alternative], before);
});

test('cached partial S2 paper metadata retains its warning without coverage or duplicate licensing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'graph-fallback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = new PersistentCache(directory);
  const warning = 'Partial Semantic Scholar acquisition: citations endpoint unavailable.';
  await cache.set(`s2:pool:v1:${s2id(1)}`, { origin: s2id(1), provider: 'semantic-scholar',
    papers: [s2paper()], source: 'cache', fetchedAt: date, coverage: 'Synthetic fixture coverage.', warning }, 60000);
  const service = new SemanticService(cache, true);
  for (let i = 0; i < 2; i++) {
    const response = await service.paper(s2id(1));
    assert.equal(response.meta.source, 'cache');
    assert.ok(response.meta.warning!.includes(warning));
    assert.equal(response.meta.warning!.split(S2_LICENSE_WARNING).length - 1, 1);
    assert.doesNotMatch(response.meta.warning!, /Synthetic fixture coverage/);
  }
});

test('coverage uses actual edge endpoints, not graphConnections or candidate-count relevance', () => {
  const g = graph([oaPaper(), oaPaper(2), oaPaper(3)], ['W1', 'W2'], [['W1', 'W3']]);
  g.nodes[1].graphConnections = 999;
  g.meta.candidateCount = 900;
  assert.deepEqual(graphCoverage(g), { nodes: 3, edges: 1, connectedOrigins: 1, candidates: 900 });
});

test('exact DOI rejects conflicting titles even when DOI URLs normalize identically', async () => {
  const origin = oaPaper(1, { doi: 'https://doi.org/10.1234/A%3AB' });
  const f = setup({ origin, results: [s2paper(1, { title: 'Different provider title', externalIds: { DOI: '10.1234/a:b' } })] });
  assert.strictEqual(await f.coordinator.graph(['W1']), f.original);
  assert.deepEqual(f.calls.s2Graph, []);
});

test('exact DOI is case-insensitive, decodes URLs once and corroborates normalized titles and authors', async () => {
  const origin = oaPaper(1, { doi: 'https://doi.org/10.1234/A%3AB', title: '  Synthetic: IDENTITY fixture! ',
    authors: ['Fixture-Author', 'Another Author'] });
  const f = setup({ origin, results: [s2paper(1, { externalIds: { DOI: '10.1234/a:b' } })] });
  assert.equal((await f.coordinator.graph(['W1'])).meta.provider, 'semantic-scholar');
  assert.deepEqual(f.calls.search, [[origin.doi!, 1]]);
  assert.deepEqual(f.calls.raw, []);
});

for (const [label, changes] of [
  ['wrong year', { year: 2025 }],
  ['wrong authors', { authors: ['Other Author'] }],
  ['placeholder title', { title: '  UNTITLED work! ' }],
  ['empty normalized title', { title: '!!!' }],
] as [string, Partial<Paper>][]) for (const side of ['origin', 'candidate']) {
  test(`exact DOI rejects ${label} on the ${side}`, async () => {
    const f = setup({ origin: oaPaper(1, side === 'origin' ? changes : {}),
      results: [{ ...s2paper(), ...(side === 'candidate' ? changes : {}) }] });
    assert.strictEqual(await f.coordinator.graph(['W1']), f.original);
    assert.deepEqual(f.calls.s2Graph, []);
  });
}

test('exact DOI does not corroborate two matching placeholder titles', async () => {
  const f = setup({ origin: oaPaper(1, { title: 'Untitled work' }), results: [s2paper(1, { title: 'Untitled work' })] });
  assert.strictEqual(await f.coordinator.graph(['W1']), f.original);
  assert.deepEqual(f.calls.s2Graph, []);
});

for (const changes of [{ year: null }, { authors: [] }, { year: null, authors: [] }]) {
  for (const side of ['origin', 'candidate']) test(`exact DOI allows missing ${side} metadata: ${JSON.stringify(changes)}`, async () => {
    const f = setup({ origin: oaPaper(1, side === 'origin' ? changes : {}),
      results: [{ ...s2paper(), ...(side === 'candidate' ? changes : {}) }] });
    assert.equal((await f.coordinator.graph(['W1'])).meta.provider, 'semantic-scholar');
    assert.deepEqual(f.calls.s2Graph, [[s2id(1)]]);
  });
}

for (const externalIds of [{ DOI: '10.1234/other' }, {}, { DOI: null }]) {
  test(`DOI lookup rejects absent or contradictory DOI: ${JSON.stringify(externalIds)}`, async () => {
    const f = setup({ results: [s2paper(1, { externalIds })] });
    assert.strictEqual(await f.coordinator.graph(['W1']), f.original);
    assert.deepEqual(f.calls.s2Graph, []);
    assert.equal(f.calls.search.length, 1, 'No title retry after a DOI mismatch');
  });
}

test('duplicate rows for the same exact DOI identity do not create ambiguity', async () => {
  const f = setup({ results: [s2paper(), s2paper()] });
  assert.equal((await f.coordinator.graph(['W1'])).meta.provider, 'semantic-scholar');
});

test('distinct S2 IDs sharing the exact DOI are ambiguous', async () => {
  const f = setup({ results: [s2paper(), s2paper(2)] });
  assert.strictEqual(await f.coordinator.graph(['W1']), f.original);
  assert.deepEqual(f.calls.s2Graph, []);
});

test('identifier-less title matching requires exact normalized title, year and author overlap', async () => {
  const origin = oaPaper(1, { doi: null, title: '  Synthetic: IDENTITY fixture! ', authors: ['Fixture-Author'] });
  const f = setup({ origin, results: [s2paper(1, { externalIds: {} })] });
  assert.equal((await f.coordinator.graph(['W1'])).meta.provider, 'semantic-scholar');
  assert.deepEqual(f.calls.search, [['Synthetic: IDENTITY fixture!', 1]]);
});

for (const [label, changes] of [
  ['fuzzy title', { title: 'Synthetic identity fixture extended' }],
  ['wrong year', { year: 2025 }],
  ['missing year', { year: null }],
  ['wrong authors', { authors: [{ name: 'Other Author' }] }],
  ['missing authors', { authors: [] }],
] as [string, Partial<SemanticPaper>][]) test(`title identity rejects ${label}`, async () => {
  const f = setup({ origin: oaPaper(1, { doi: null }), results: [s2paper(1, changes)] });
  assert.strictEqual(await f.coordinator.graph(['W1']), f.original);
  assert.deepEqual(f.calls.s2Graph, []);
});

test('distinct exact title/year/author matches are ambiguous, not first-result wins', async () => {
  const f = setup({ origin: oaPaper(1, { doi: null }), results: [s2paper(), s2paper(2)] });
  assert.strictEqual(await f.coordinator.graph(['W1']), f.original);
  assert.deepEqual(f.calls.s2Graph, []);
});

test('duplicate title identity rows are deduplicated by canonical ID', async () => {
  const f = setup({ origin: oaPaper(1, { doi: null }), results: [s2paper(), s2paper()] });
  assert.equal((await f.coordinator.graph(['W1'])).meta.provider, 'semantic-scholar');
});

test('title search only checks the first page, not advertised total or later candidates', async () => {
  const f = setup({ origin: oaPaper(1, { doi: null }), results: [] });
  f.handlers.search = async () => ({ results: [], total: 1000, page: 1, perPage: 20, meta: f.alternative.meta });
  assert.strictEqual(await f.coordinator.graph(['W1']), f.original);
  assert.deepEqual(f.calls.search, [[f.origin.title, 1]]);
});

for (const title of ['x'.repeat(201), 'Invalid\nTitle', '   ']) test(`unusable title is not queried: ${JSON.stringify(title.slice(0, 20))}`, async () => {
  const f = setup({ origin: oaPaper(1, { doi: null, title }) });
  assert.strictEqual(await f.coordinator.graph(['W1']), f.original);
  noSemanticCalls(f.calls);
});

test('a 200-character title remains eligible', async () => {
  const title = 'x'.repeat(200), f = setup({ origin: oaPaper(1, { doi: null, title }), results: [s2paper(1, { title })] });
  assert.equal((await f.coordinator.graph(['W1'])).meta.provider, 'semantic-scholar');
});

for (const url of ['https://arxiv.org/abs/2609.31142v2', 'https://www.arxiv.org/pdf/2609.31142v3.pdf',
  'http://arxiv.org/pdf/2609.31142', 'https://arxiv.org/abs/hep-th/9901001v2']) test(`official arXiv alias resolves once: ${url}`, async () => {
  const legacy = url.includes('hep-th'), alias = legacy ? 'hep-th/9901001' : '2609.31142';
  const f = setup({ origin: oaPaper(1, { doi: null, url }), raw: rawPaper(1, { externalIds: { ArXiv: `${alias}v7` } }) });
  assert.equal((await f.coordinator.graph(['W1'])).meta.provider, 'semantic-scholar');
  assert.deepEqual(f.calls.raw, [`ARXIV:${alias}`]);
  assert.deepEqual(f.calls.search, [], 'Raw verification replaces normalized search, not a second lookup');
});

test('arXiv is preferred over DOI and contradictory DOI metadata fails closed', async () => {
  const f = setup({ origin: oaPaper(1, { url: 'https://arxiv.org/abs/2609.31142' }),
    raw: rawPaper(1, { externalIds: { ArXiv: '2609.31142', DOI: '10.1234/other' } }) });
  assert.strictEqual(await f.coordinator.graph(['W1']), f.original);
  assert.deepEqual(f.calls.raw, ['ARXIV:2609.31142']);
  assert.deepEqual(f.calls.search, []);
  assert.deepEqual(f.calls.s2Graph, []);
});

for (const [label, changes] of [
  ['wrong raw arXiv', { externalIds: { ArXiv: '2609.31143' } }],
  ['missing raw arXiv', { externalIds: {} }],
  ['URL only', { externalIds: {}, url: 'https://arxiv.org/abs/2609.31142' }],
  ['fuzzy title', { externalIds: { ArXiv: '2609.31142' }, title: 'Synthetic identity fixtures' }],
  ['wrong year', { externalIds: { ArXiv: '2609.31142' }, year: 2025 }],
  ['wrong authors', { externalIds: { ArXiv: '2609.31142' }, authors: [{ name: 'Other Author' }] }],
  ['no corroboration', { externalIds: { ArXiv: '2609.31142' }, year: null, authors: [] }],
] as [string, Partial<SemanticPaper>][]) test(`arXiv verification rejects ${label}`, async () => {
  const f = setup({ origin: oaPaper(1, { doi: null, url: 'https://arxiv.org/abs/2609.31142' }), raw: rawPaper(1, changes) });
  assert.strictEqual(await f.coordinator.graph(['W1']), f.original);
  assert.equal(f.calls.raw.length, 1);
  assert.deepEqual(f.calls.search, []);
  assert.deepEqual(f.calls.s2Graph, []);
});

for (const changes of [{ year: null }, { authors: [] }]) test(`arXiv exact title requires one known corroborator: ${JSON.stringify(changes)}`, async () => {
  const f = setup({ origin: oaPaper(1, { doi: null, url: 'https://arxiv.org/abs/2609.31142' }),
    raw: rawPaper(1, { externalIds: { ArXiv: '2609.31142' }, ...changes }) });
  assert.equal((await f.coordinator.graph(['W1'])).meta.provider, 'semantic-scholar');
});

for (const url of ['https://evil.test/abs/2609.31142', 'https://arxiv.org.evil.test/abs/2609.31142',
  'https://arxiv.org@evil.test/abs/2609.31142', 'https://user:secret@arxiv.org/abs/2609.31142',
  'https://arxiv.org:8080/abs/2609.31142', 'https://arxiv.org/abs/2609.31142?next=evil',
  'https://arxiv.org/abs/2609.31142#alias', 'https://arxiv.org/html/2609.31142',
  'https://arxiv.org/abs/not-an-id', 'ARXIV:2609.31142', 'file://arxiv.org/abs/2609.31142',
  'https://arxiv.org/abs/2609.31142\n']) test(`untrusted URL cannot establish an arXiv alias: ${JSON.stringify(url)}`, async () => {
  const f = setup({ origin: oaPaper(1, { url }) });
  assert.equal((await f.coordinator.graph(['W1'])).meta.provider, 'semantic-scholar');
  assert.deepEqual(f.calls.raw, []);
  assert.deepEqual(f.calls.search, [[f.origin.doi!, 1]]);
});

test('supplied JevAdvBench research identity resolves without inventing an arXiv field in Paper', async () => {
  // Exact identity fields from the supplied offline research, not a live S2 request.
  const title = 'JevAdvBench: A Benchmark and Black-Box Attacks for Reinforcement Learning for Calibrated Decisions Models';
  const hash = 'f344f25394b33074f88432f7c0ed4b1fdffc8d3a';
  const authors = ['Jian-Yi Hu', 'Hang Zhang', 'Yi Liu', 'Ye-Qi Zeng', 'Li Zeng', 'Xian-Long Wang', 'Rui Wang', 'L. Zhang'];
  const raw: SemanticPaper = { paperId: hash, title, year: 2026, authors: authors.map(name => ({ name })),
    externalIds: { ArXiv: '2609.31142' }, url: `https://www.semanticscholar.org/paper/${hash}` };
  const paper = normalizeSemanticPaper(raw);
  assert.equal('arxiv' in paper, false);
  assert.equal(paper.url, `https://www.semanticscholar.org/paper/${hash}`);
  const origin = oaPaper(1, { id: 'W7214809189', title, year: 2026, authors, doi: null, url: 'https://arxiv.org/abs/2609.31142' });
  const f = setup({ origin, raw, alternative: graph([paper, s2paper(2)]) });
  const response = await f.coordinator.graph([origin.id]);
  assert.deepEqual(response.origins, [`S2:${hash}`]);
  assert.deepEqual(response.meta.fallback?.requestedOrigins, [origin.id]);
  assert.deepEqual(f.calls.raw, ['ARXIV:2609.31142']);
  assert.deepEqual(f.calls.search, []);
});

test('503 fallback fetches exact origin metadata and records null OA coverage', async () => {
  const f = setup(), error = new ApiError(503, 'Original outage');
  f.handlers.oaGraph = async () => { throw error; };
  const response = await f.coordinator.graph(['W1']);
  assert.deepEqual(f.calls.oaGraph, [['W1']]);
  assert.deepEqual(f.calls.oaPaper, ['W1']);
  assert.equal(response.meta.fallback?.reason, 'openalex_unavailable');
  assert.equal(response.meta.fallback?.comparison.openalex, null);
});

test('neighborhood 404 is eligible only after exact OA paper retrieval succeeds', async () => {
  const f = setup();
  f.handlers.oaGraph = async () => { throw new ApiError(404, 'Neighborhood record missing'); };
  assert.equal((await f.coordinator.graph(['W1'])).meta.provider, 'semantic-scholar');
  assert.deepEqual(f.calls.oaPaper, ['W1']);
});

for (const staleGraph of [false, true]) test(`real origin 404 cannot be overridden by fresh search metadata (stale graph: ${staleGraph})`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'graph-fallback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = new PersistentCache(directory), f = setup();
  await cache.set('search:1:identity fixture', { results: [f.origin], total: 1, page: 1, perPage: 20,
    meta: { provider: 'openalex', source: 'cache', fetchedAt: date } }, 60000);
  if (staleGraph) await cache.set('graph:v1:W1', { ...f.original, meta: { ...f.original.meta, algorithm: ALGORITHM } }, -1);
  const requests: string[] = [];
  const provider = new OpenAlexProvider({ cache, fetch: async input => {
    requests.push(new URL(String(input)).pathname);
    return new Response('Private upstream response', { status: 404 });
  } });
  const service = new PaperService(cache, false, provider);
  await service.ready;
  assert.equal((await service.paper('W1')).paper.title, f.origin.title, 'Fresh metadata exists before the origin request');
  const coordinator = new GraphFallbackCoordinator(service, f.semantic, true);
  await assert.rejects(coordinator.graph(['W1']), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 404);
    assert.equal(error.code, 'origin_not_found');
    assert.equal(error.message, 'Paper W1 not found');
    return true;
  });
  assert.equal((await service.paper('W1')).paper.title, f.origin.title, 'Fresh metadata still exists after the origin 404');
  assert.deepEqual(requests, ['/works/W1']);
  noSemanticCalls(f.calls);
});

test('real neighborhood 404 remains eligible through provider-cached exact origin metadata', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'graph-fallback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = new PersistentCache(directory), f = setup();
  const origin: OpenAlexWork = { id: 'https://openalex.org/W1', display_name: f.origin.title,
    publication_year: f.origin.year, doi: f.origin.doi,
    authorships: f.origin.authors.map(display_name => ({ author: { display_name } })) };
  const requests: string[] = [];
  const provider = new OpenAlexProvider({ cache, fetch: async input => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    return path === '/works/W1' ? Response.json(origin) : new Response('Private neighborhood response', { status: 404 });
  } });
  const service = new PaperService(cache, false, provider);
  f.handlers.oaGraph = async (ids, signal) => {
    try { return await service.graph(ids, signal); }
    catch (error) {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 404);
      assert.equal(error.code, 'neighborhood_unavailable');
      assert.doesNotMatch(error.message, /Private neighborhood response/);
      throw error;
    }
  };
  f.handlers.oaPaper = (id, signal) => service.paper(id, signal);
  const response = await f.coordinator.graph(['W1']);
  assert.equal(response.meta.provider, 'semantic-scholar');
  assert.equal(response.meta.fallback?.reason, 'openalex_unavailable');
  assert.doesNotMatch(response.meta.warning!, /Private neighborhood response/);
  assert.deepEqual(requests, ['/works/W1', '/works']);
  assert.deepEqual(f.calls.oaPaper, ['W1']);
  assert.deepEqual(f.calls.search, [[f.origin.doi!, 1]]);
  assert.deepEqual(f.calls.s2Graph, [[s2id(1)]]);
});

test('explicit origin 404 preserves the same error without retrying cached metadata', async () => {
  const f = setup(), error = new ApiError(404, 'Paper W1 not found', 'origin_not_found');
  f.handlers.oaGraph = async () => { throw error; };
  await assert.rejects(f.coordinator.graph(['W1']), e => e === error);
  assert.deepEqual(f.calls.oaPaper, []);
  noSemanticCalls(f.calls);
});

for (const status of [404, 503]) test(`OA metadata failure ${status} after graph 404 preserves the original error`, async () => {
  const f = setup(), error = new ApiError(404, 'Original missing origin');
  f.handlers.oaGraph = async () => { throw error; };
  f.handlers.oaPaper = async () => { throw new ApiError(status, 'Metadata failed'); };
  await assert.rejects(f.coordinator.graph(['W1']), e => e === error);
  noSemanticCalls(f.calls);
});

for (const error of [new ApiError(400, 'Validation'), new ApiError(500, 'Unexpected'), new Error('Non-API error')]) {
  test(`ineligible OA error never calls S2: ${error.message}`, async () => {
    const f = setup();
    f.handlers.oaGraph = async () => { throw error; };
    await assert.rejects(f.coordinator.graph(['W1']), e => e === error);
    assert.deepEqual(f.calls.oaPaper, []);
    noSemanticCalls(f.calls);
  });
}

test('an OA graph node not marked as origin requires exact paper retrieval', async () => {
  const f = setup();
  f.original.nodes[0].isOrigin = false;
  assert.equal((await f.coordinator.graph(['W1'])).meta.provider, 'semantic-scholar');
  assert.deepEqual(f.calls.oaPaper, ['W1']);
});

test('exact OA metadata ID mismatch prevents S2 work', async () => {
  const f = setup(), error = new ApiError(503, 'Original outage');
  f.handlers.oaGraph = async () => { throw error; };
  f.handlers.oaPaper = async () => ({ paper: oaPaper(2), meta: f.original.meta });
  await assert.rejects(f.coordinator.graph(['W1']), e => e === error);
  noSemanticCalls(f.calls);
});

test('multi-origin resolution preserves order and uses only exact origin nodes', async () => {
  const papers = [oaPaper(), oaPaper(2, { doi: null }), oaPaper(3, { doi: null, url: 'https://arxiv.org/abs/2609.31142' })];
  const original = graph(papers, ['W3', 'W1', 'W2'], []);
  const alternative = graph([s2paper(), s2paper(2), s2paper(3), s2paper(4)], [s2id(3), s2id(1), s2id(2)],
    [[s2id(3), s2id(4)], [s2id(1), s2id(4)], [s2id(2), s2id(4)]]);
  const f = setup({ original, alternative, raw: rawPaper(3, { externalIds: { ArXiv: '2609.31142' } }) });
  f.handlers.search = async (q, page) => ({ results: [q === papers[0].doi ? s2paper() : s2paper(2)],
    total: 1, page, perPage: 20, meta: alternative.meta });
  const response = await f.coordinator.graph(['W3', 'W1', 'W2']);
  assert.deepEqual(response.origins, [s2id(3), s2id(1), s2id(2)]);
  assert.deepEqual(response.meta.fallback?.requestedOrigins, ['W3', 'W1', 'W2']);
  assert.deepEqual(f.calls.s2Graph, [[s2id(3), s2id(1), s2id(2)]]);
  assert.deepEqual(f.calls.oaPaper, []);
});

test('all exact OA metadata is resolved before S2 when graph acquisition fails', async () => {
  const f = setup(), error = new ApiError(503, 'Original outage');
  f.handlers.oaGraph = async () => { throw error; };
  f.handlers.oaPaper = async id => {
    if (id === 'W2') throw new ApiError(404, 'Second origin missing');
    return { paper: f.origin, meta: f.original.meta };
  };
  await assert.rejects(f.coordinator.graph(['W1', 'W2']), e => e === error);
  assert.deepEqual(f.calls.oaPaper, ['W1', 'W2']);
  noSemanticCalls(f.calls);
});

test('different OA origins resolving to one S2 ID do not collapse the origin set', async () => {
  const f = setup({ original: graph([oaPaper(), oaPaper(2)], ['W1', 'W2'], []) });
  assert.strictEqual(await f.coordinator.graph(['W1', 'W2']), f.original);
  assert.equal(f.calls.search.length, 2);
  assert.deepEqual(f.calls.s2Graph, []);
});

test('one unresolved multi-origin identity prevents graph acquisition', async () => {
  const f = setup({ original: graph([oaPaper(), oaPaper(2, { doi: null })], ['W1', 'W2'], []) });
  f.handlers.search = async (q, page) => ({ results: q === f.origin.doi ? [s2paper()] : [],
    total: 1, page, perPage: 20, meta: f.alternative.meta });
  assert.strictEqual(await f.coordinator.graph(['W1', 'W2']), f.original);
  assert.deepEqual(f.calls.s2Graph, []);
});

for (const [label, original, alternative] of [
  ['equal graph with more candidates', graph([oaPaper(), oaPaper(2)]), graph([s2paper(), s2paper(2)])],
  ['fewer nodes despite more edges', graph([oaPaper(), oaPaper(2), oaPaper(3)], ['W1'], []), graph([s2paper(), s2paper(2)])],
  ['fewer edges despite more nodes', graph([oaPaper(), oaPaper(2), oaPaper(3)]), graph([s2paper(), s2paper(2), s2paper(3), s2paper(4)], [s2id(1)], [[s2id(1), s2id(2)]])],
  ['disconnected origin despite larger graph', graph([oaPaper(), oaPaper(2)]), graph([s2paper(), s2paper(2), s2paper(3), s2paper(4)], [s2id(1)], [[s2id(2), s2id(3)], [s2id(3), s2id(4)]])],
  ['no edges', graph([oaPaper()]), graph([s2paper(), s2paper(2)], [s2id(1)], [])],
] as [string, GraphResponse, GraphResponse][]) test(`weaker S2 coverage returns original OA object: ${label}`, async () => {
  alternative.meta.candidateCount = 50000;
  const f = setup({ original, alternative });
  assert.strictEqual(await f.coordinator.graph(['W1']), original);
  assert.deepEqual(f.calls.s2Graph, [[s2id(1)]]);
});

test('more edges alone is a strict coverage improvement; fewer candidates are irrelevant', async () => {
  const original = graph([oaPaper(), oaPaper(2), oaPaper(3)]);
  original.meta.candidateCount = 50000;
  const alternative = graph([s2paper(), s2paper(2), s2paper(3)], [s2id(1)],
    [[s2id(1), s2id(2)], [s2id(1), s2id(3)], [s2id(2), s2id(3)]]);
  const f = setup({ original, alternative });
  assert.equal((await f.coordinator.graph(['W1'])).meta.provider, 'semantic-scholar');
});

for (const improves of [true, false]) test(`multi-origin connected coverage ${improves ? 'improves' : 'regresses'} with equal node and edge counts`, async () => {
  const original = graph([oaPaper(), oaPaper(2), oaPaper(3)], ['W1', 'W2'],
    improves ? [['W1', 'W3']] : [['W1', 'W2']]);
  const alternative = graph([s2paper(), s2paper(2), s2paper(3)], [s2id(1), s2id(2)],
    improves ? [[s2id(1), s2id(2)]] : [[s2id(1), s2id(3)]]);
  original.nodes[1].doi = 'https://doi.org/10.1234/second';
  const f = setup({ original, alternative });
  f.handlers.search = async (q, page) => ({ results: [q === f.origin.doi ? s2paper() : s2paper(2, { externalIds: { DOI: '10.1234/second' } })],
    total: 1, page, perPage: 20, meta: alternative.meta });
  const response = await f.coordinator.graph(['W1', 'W2']);
  if (improves) {
    assert.equal(response.meta.provider, 'semantic-scholar');
    assert.equal(response.meta.fallback?.comparison.semanticScholar.connectedOrigins, 2);
  } else assert.strictEqual(response, original);
});

for (const stage of ['search', 'raw', 's2Graph'] as const) test(`S2 ${stage} failure preserves existing OA response`, async () => {
  const f = setup({ origin: oaPaper(1, stage === 'raw' ? { url: 'https://arxiv.org/abs/2609.31142' } : {}) });
  f.handlers[stage] = async () => { throw new SemanticScholarError(503, 'Fixture S2 failure'); };
  assert.strictEqual(await f.coordinator.graph(['W1']), f.original);
  assert.equal(f.calls.oaGraph.length, 1);
});

for (const stage of ['search', 'raw', 's2Graph'] as const) test(`S2 ${stage} failure without OA rethrows original OA error`, async () => {
  const f = setup({ origin: oaPaper(1, stage === 'raw' ? { url: 'https://arxiv.org/abs/2609.31142' } : {}) });
  const error = new ApiError(503, 'Original OA failure');
  f.handlers.oaGraph = async () => { throw error; };
  f.handlers[stage] = async () => { throw new SemanticScholarError(429, 'Fixture rate limit'); };
  await assert.rejects(f.coordinator.graph(['W1']), e => e === error);
  assert.equal(f.calls.oaGraph.length, 1);
});

test('unresolved identity or edge-less S2 graph without OA rethrows original error', async () => {
  for (const options of [{ results: [] }, { alternative: graph([s2paper()]) }]) {
    const f = setup(options), error = new ApiError(503, 'Original OA failure');
    f.handlers.oaGraph = async () => { throw error; };
    await assert.rejects(f.coordinator.graph(['W1']), e => e === error);
  }
});

for (const [label, mutate] of [
  ['wrong provider', (g: GraphResponse) => { g.meta.provider = 'openalex'; }],
  ['wrong origins', (g: GraphResponse) => { g.origins = [s2id(2)]; }],
  ['mixed prior IDs', (g: GraphResponse) => { g.prior = [{ ...g.nodes[1], id: 'W2' }]; }],
  ['mixed references', (g: GraphResponse) => { g.nodes[1].references = ['W2']; }],
  ['empty displayed nodes', (g: GraphResponse) => { g.nodes = []; }],
  ['edge endpoint absent', (g: GraphResponse) => { g.edges[0].target = s2id(99); }],
] as [string, (g: GraphResponse) => void][]) test(`invalid alternative fails closed: ${label}`, async () => {
  const f = setup();
  mutate(f.alternative);
  assert.strictEqual(await f.coordinator.graph(['W1']), f.original);
});

for (const ids of [[], ['W1', 'W1'], ['W1', 'W2', 'W3', 'W4'], [s2id(1)], ['W0'], ['https://openalex.org/W1']]) {
  test(`invalid requested origins are rejected without provider calls: ${JSON.stringify(ids)}`, async () => {
    const f = setup();
    await assert.rejects(f.coordinator.graph(ids), e => e instanceof ApiError && e.status === 400);
    assert.deepEqual(f.calls.oaGraph, []);
    noSemanticCalls(f.calls);
  });
}

test('pre-aborted route signal makes no calls and preserves the abort reason', async () => {
  const f = setup(), controller = new AbortController(), reason = new Error('Route cancelled');
  controller.abort(reason);
  await assert.rejects(f.coordinator.graph(['W1'], controller.signal), e => e === reason);
  assert.deepEqual(f.calls.oaGraph, []);
  noSemanticCalls(f.calls);
});

for (const stage of ['oaGraph', 'oaPaper', 'search', 'raw', 's2Graph'] as const) {
  test(`route cancellation during ${stage} stops later calls and never returns OA`, async () => {
    const f = setup({ origin: oaPaper(1, stage === 'raw' ? { url: 'https://arxiv.org/abs/2609.31142' } : {}) });
    const controller = new AbortController(), reason = new Error(`Cancelled at ${stage}`);
    if (stage === 'oaPaper') f.handlers.oaGraph = async () => { throw new ApiError(503, 'Outage'); };
    f.handlers[stage] = async () => { controller.abort(reason); throw new ApiError(503, 'Failure after abort'); };
    await assert.rejects(f.coordinator.graph(['W1'], controller.signal), e => e === reason);
    assert.equal(f.calls.oaGraph.length, 1);
    assert.ok(f.calls.signals.every(signal => signal?.aborted && signal.reason === reason), 'combined deadlines retain caller cancellation');
    if (stage === 'oaGraph' || stage === 'oaPaper') noSemanticCalls(f.calls);
    if (stage === 'search' || stage === 'raw') assert.deepEqual(f.calls.s2Graph, []);
  });
}

test('abort after successful OA acquisition is checked before any S2 call', async () => {
  const f = setup(), controller = new AbortController(), reason = new Error('Cancelled after OA');
  f.handlers.oaGraph = async () => { controller.abort(reason); return f.original; };
  await assert.rejects(f.coordinator.graph(['W1'], controller.signal), e => e === reason);
  noSemanticCalls(f.calls);
});

test('cancellation after resolving the first origin prevents remaining identities and graph acquisition', async () => {
  const f = setup({ original: graph([oaPaper(), oaPaper(2)], ['W1', 'W2'], []) });
  const controller = new AbortController(), reason = new Error('Cancelled between origins');
  f.handlers.search = async (_q, page) => {
    controller.abort(reason);
    return { results: [s2paper()], total: 1, page, perPage: 20, meta: f.alternative.meta };
  };
  await assert.rejects(f.coordinator.graph(['W1', 'W2'], controller.signal), e => e === reason);
  assert.equal(f.calls.search.length, 1);
  assert.deepEqual(f.calls.s2Graph, []);
});

for (const name of ['AbortError', 'TimeoutError']) test(`${name} thrown by a service is not treated as fallback`, async () => {
  const error = new DOMException('Cancelled upstream', name);
  const f = setup();
  f.handlers.oaGraph = async () => { throw error; };
  await assert.rejects(f.coordinator.graph(['W1']), e => e === error);
  noSemanticCalls(f.calls);
  f.handlers.oaGraph = async () => f.original;
  f.handlers.search = async () => { throw error; };
  await assert.rejects(f.coordinator.graph(['W1']), e => e === error);
  assert.deepEqual(f.calls.s2Graph, []);
});

test('repeated calls use service seams without mutating or caching fallback as an OA graph', async () => {
  const f = setup();
  const first = await f.coordinator.graph(['W1']), second = await f.coordinator.graph(['W1']);
  assert.deepEqual(first, second);
  assert.equal(f.calls.oaGraph.length, 2);
  assert.equal(f.calls.s2Graph.length, 1);
  assert.equal(f.original.meta.provider, 'openalex');
  assert.equal(f.original.meta.fallback, undefined);
  assert.equal(f.alternative.meta.fallback, undefined);
});
