import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import type { GraphEdge, GraphResponse, Paper } from '../shared/types.ts';
import { ALGORITHM, buildGraph, pruneEdges } from './graph.ts';
import { ReferenceIndex, type EdgeEvidence, type GraphIndex } from './indexed-scoring.ts';

const paper = (id: string, references: string[] = [], citations = 0): Paper => ({
  id, references, citations, title: id, authors: [], year: 2020, venue: '', abstract: '',
  doi: null, url: `https://openalex.org/${id}`, pdfUrl: null, openAccess: false, topics: ['Same topic'],
});
const meta: GraphResponse['meta'] = {
  source: 'snapshot', fetchedAt: '2026-01-01T00:00:00.000Z', candidateCount: 0, algorithm: '', coverage: 'Test fixture only',
};

// Independent copy of the old set-intersection scoring, not a posting-based oracle.
function bruteIndex(papers: Paper[]): GraphIndex {
  const records = new Map(papers.map(p => [p.id, p]));
  const refs = new Map([...records.values()].map(p => [p.id, new Set(p.references.filter(id => id !== p.id))]));
  const citers = new Map([...records.keys()].map(id => [id, new Set<string>()]));
  for (const [id, references] of refs) for (const reference of references) citers.get(reference)?.add(id);
  const overlap = (a: Set<string>, b: Set<string>) => [...a].filter(id => b.has(id)).length;
  const evidence = (a: string, b: string): EdgeEvidence => {
    const ra = refs.get(a)!, rb = refs.get(b)!, ca = citers.get(a)!, cb = citers.get(b)!;
    const sharedReferences = overlap(ra, rb), coCitations = overlap(ca, cb);
    return { weight: ((ra.size && rb.size ? sharedReferences / Math.sqrt(ra.size * rb.size) : 0)
      + (ca.size && cb.size ? coCitations / Math.sqrt(ca.size * cb.size) : 0)) / 2, sharedReferences, coCitations };
  };
  return {
    size: records.size, papers: () => records.values(), paper: id => records.get(id), evidence,
    scores: anchor => new Map([...records.keys()].filter(id => id !== anchor).map(id => [id, evidence(anchor, id)] as const)
      .filter(([, value]) => value.weight > 0)),
    prior: selected => [...records.values()].map(p => ({ ...p, similarity: 0, sharedReferences: 0, coCitations: 0,
      graphConnections: [...new Set(selected)].filter(id => refs.get(id)!.has(p.id)).length, isOrigin: false }))
      .filter(p => p.graphConnections >= 2),
  };
}

// Preserve the old selection's citation/ID tie-breaking, including its sparse fallback.
function bruteGraph(index: GraphIndex, origins: string[]): GraphResponse {
  const best = (id: string) => Math.max(0, ...origins.filter(origin => origin !== id).map(origin => index.evidence(id, origin).weight));
  const chosen = new Set(origins);
  const candidates = [...index.papers()].filter(p => !chosen.has(p.id))
    .sort((a, b) => best(b.id) - best(a.id) || b.citations - a.citations || a.id.localeCompare(b.id));
  // Papers an origin cites or is cited by come first, with or without similarity evidence.
  const directSlots = Math.max(0, Math.floor((40 - origins.length) / origins.length) - 8);
  const linked = (origin: string) => [...index.papers()].filter(p => !origins.includes(p.id)
    && (index.paper(origin)!.references.includes(p.id) || p.references.includes(origin)));
  for (const origin of origins) {
    for (const p of linked(origin).sort((a, b) => index.evidence(b.id, origin).weight - index.evidence(a.id, origin).weight
      || b.citations - a.citations || a.id.localeCompare(b.id)).slice(0, directSlots)) chosen.add(p.id);
  }
  for (const origin of origins) {
    for (const p of candidates.filter(p => index.evidence(p.id, origin).weight > 0)
      .sort((a, b) => index.evidence(b.id, origin).weight - index.evidence(a.id, origin).weight || a.id.localeCompare(b.id)).slice(0, 8)) chosen.add(p.id);
  }
  for (const p of candidates) {
    if (chosen.size >= 40) break;
    if (best(p.id) > 0) chosen.add(p.id);
  }
  while (chosen.size < 40) {
    let selected: string | undefined, weight = 0;
    for (const p of candidates) if (!chosen.has(p.id)) {
      for (const neighbor of chosen) {
        const next = index.evidence(p.id, neighbor).weight;
        if (next > weight) { selected = p.id; weight = next; }
      }
    }
    if (!selected) break;
    chosen.add(selected);
  }
  const ids = [...chosen];
  const evidenced: GraphEdge[] = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const value = index.evidence(ids[i], ids[j]);
    if (value.weight > 0) evidenced.push({ source: ids[i], target: ids[j], ...value });
  }
  const edges = pruneEdges(ids, evidenced);
  for (const origin of origins) for (const p of linked(origin)) {
    if (chosen.has(p.id) && index.evidence(origin, p.id).weight === 0) {
      edges.push({ source: origin, target: p.id, weight: 0, sharedReferences: 0, coCitations: 0, directCitation: true });
    }
  }
  const decorate = (p: Paper, graphConnections = edges.filter(e => e.source === p.id || e.target === p.id).length) => {
    let evidence: EdgeEvidence = { weight: 0, sharedReferences: 0, coCitations: 0 };
    for (const origin of origins) if (origin !== p.id) {
      const next = index.evidence(p.id, origin);
      if (next.weight > evidence.weight) evidence = next;
    }
    return { ...p, similarity: origins.includes(p.id) ? 1 : evidence.weight,
      sharedReferences: evidence.sharedReferences, coCitations: evidence.coCitations,
      graphConnections, isOrigin: origins.includes(p.id) };
  };
  const nodes = ids.map(id => decorate(index.paper(id)!)).sort((a, b) =>
    Number(b.isOrigin) - Number(a.isOrigin) || b.similarity - a.similarity || a.id.localeCompare(b.id));
  const rank = (a: typeof nodes[number], b: typeof nodes[number]) =>
    b.graphConnections - a.graphConnections || b.citations - a.citations || a.id.localeCompare(b.id);
  const priorCounts = new Map<string, number>();
  for (const id of ids) for (const reference of new Set(index.paper(id)!.references.filter(ref => ref !== id))) {
    priorCounts.set(reference, (priorCounts.get(reference) ?? 0) + 1);
  }
  const prior = [...index.papers()].filter(p => !origins.includes(p.id) && (priorCounts.get(p.id) ?? 0) >= 2)
    .map(p => decorate(p, priorCounts.get(p.id))).sort(rank).slice(0, 20);
  const derivative = [...index.papers()].filter(p => !origins.includes(p.id))
    .map(p => decorate(p, [...new Set(p.references.filter(ref => ref !== p.id))].filter(id => chosen.has(id)).length))
    .filter(p => p.graphConnections >= 2).sort(rank).slice(0, 20);
  return { origins: [...origins], nodes, edges, prior, derivative,
    meta: { ...meta, candidateCount: index.size, algorithm: ALGORITHM,
      ...(nodes.length < 35 ? { warning: `Only ${nodes.length} evidence-connected nodes were available; no artificial edges were added.` } : {}) } };
}

class CountingIndex extends ReferenceIndex {
  readonly anchors: string[] = [];
  pairs = 0;
  override scores(anchor: string): Map<string, EdgeEvidence> {
    this.anchors.push(anchor);
    return super.scores(anchor);
  }
  override evidence(a: string, b: string): EdgeEvidence {
    this.pairs++;
    return super.evidence(a, b);
  }
}

test('posting scores exactly match old brute scoring: external references, all member citers, duplicates and self refs', () => {
  const papers = [paper('W1', ['W1', 'W90', 'W91', 'W90']), paper('W2', ['W90', 'W92']),
    paper('W3'), paper('W4', ['W1', 'W2', 'W3', 'W3', 'W99']), paper('W5', ['W1']),
    paper('W6', ['W2', 'W3']), paper('W7', ['W7']), paper('W8', ['W1'])];
  const index = new ReferenceIndex(papers), brute = bruteIndex(papers);
  for (const a of papers) {
    assert.deepEqual([...index.scores(a.id)].sort(), [...brute.scores(a.id)].sort());
    assert.ok(!index.scores(a.id).has(a.id));
    for (const b of papers) {
      assert.deepEqual(index.evidence(a.id, b.id), brute.evidence(a.id, b.id));
      assert.deepEqual(index.evidence(a.id, b.id), index.evidence(b.id, a.id));
    }
  }
  assert.equal(index.evidence('W1', 'W2').weight, (0.5 + 1 / Math.sqrt(6)) / 2);
  assert.equal(index.evidence('W1', 'W2').coCitations, 1);
  assert.ok(!index.scores('W1').has('W8'), 'Direct citation alone is not evidence');
  assert.ok(!index.scores('W1').has('W7'), 'Topic labels are not evidence');
  assert.deepEqual(index.prior(['W1', 'W2']), [], 'External targets must not become invented papers');
  assert.deepEqual(index.prior(['W4', 'W5', 'W5']), brute.prior(['W4', 'W5', 'W5']));
  assert.throws(() => index.scores('missing'), /missing from the index/);
  assert.throws(() => index.evidence('W1', 'missing'), /missing from the index/);
});

test('deterministic mixed fixtures match brute scores and legacy graph selection', () => {
  let seed = 17;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let fixture = 0; fixture < 5; fixture++) {
    const papers = Array.from({ length: 65 }, (_, i) => paper(`W${i}`, Array.from({ length: random() % 9 }, () => `W${random() % 95}`), random() % 50));
    const index = new ReferenceIndex(papers), brute = bruteIndex(papers);
    for (const p of papers) {
      assert.deepEqual([...index.scores(p.id)].sort(), [...brute.scores(p.id)].sort());
      for (const other of papers) assert.deepEqual(index.evidence(p.id, other.id), brute.evidence(p.id, other.id));
    }
    const origins = ['W0', 'W29', 'W64'];
    const graph = buildGraph(index, origins, meta);
    assert.deepEqual(graph, buildGraph(brute, origins, meta));
    assert.deepEqual(graph, bruteGraph(brute, origins));
  }
});

test('actual bundled fixtures retain exact brute graph scores, rankings and graph hashes', async t => {
  const snapshot = JSON.parse(await readFile(new URL('../data/snapshot.json', import.meta.url), 'utf8')) as {
    groups: { origin: string; papers: Paper[] }[];
  };
  for (const group of snapshot.groups) {
    const graph = buildGraph(group.papers, [group.origin], meta);
    const brute = bruteIndex(group.papers);
    const expected = bruteGraph(brute, [group.origin]);
    assert.deepEqual(graph, expected);
    const hash = (g: GraphResponse) => createHash('sha256').update(JSON.stringify({
      origins: g.origins, nodes: g.nodes, edges: g.edges, prior: g.prior, derivative: g.derivative,
    })).digest('hex');
    assert.equal(hash(graph), hash(expected));
    t.diagnostic(`${group.origin}: ${group.papers.length} real snapshot candidates, graph SHA256 ${hash(graph)}`);
    assert.ok(graph.nodes.length === 40);
    assert.ok(graph.edges.length < 40 * 39 / 4);
  }
});

test('each of three uneven fields retains its origin and eight strongest neighbors', () => {
  const papers: Paper[] = [];
  const origins = ['W0', 'W100', 'W200'];
  for (let field = 0; field < 3; field++) {
    papers.push(paper(origins[field], [`field-${field}`]));
    for (let i = 1; i <= 55; i++) papers.push(paper(`W${field * 100 + i}`, i <= 8
      ? [`field-${field}`] : [`field-${field}`, `unique-${field}-${i}`], field === 0 ? 1_000_000 : 0));
  }
  const index = new CountingIndex(papers), graph = buildGraph(index, origins, { ...meta, warning: 'Existing warning.' });
  assert.equal(graph.nodes.length, 40);
  assert.deepEqual(graph.origins, origins);
  assert.deepEqual(graph.nodes.filter(p => p.isOrigin).map(p => p.id), [...origins].sort((a, b) => a.localeCompare(b)));
  for (let field = 0; field < 3; field++) for (let i = 1; i <= 8; i++) {
    assert.ok(graph.nodes.some(p => p.id === `W${field * 100 + i}`));
  }
  assert.deepEqual(index.anchors, origins, 'Dense graphs need scores only for origins');
  assert.equal(index.pairs, 780);
  assert.equal(graph.meta.candidateCount, papers.length);
  assert.equal(graph.meta.warning, 'Existing warning.');
  assert.equal(graph.meta.algorithm, ALGORITHM);
  assert.match(ALGORITHM, /indexed-v2.*sample-local.*4 strongest.*maximum spanning forest/);
});

test('sparse indexed expansion follows selected neighbors only, stops at 40 and matches legacy ties', () => {
  for (const size of [1, 2, 7, 34, 40, 60]) {
    const papers = Array.from({ length: size }, (_, i) => paper(`W${i}`, [
      ...(i ? [`link-${i - 1}`] : []), ...(i + 1 < size ? [`link-${i}`] : []),
    ], i));
    papers.push(paper('W999', ['unrelated']), paper('W998', ['W0']));
    const index = new CountingIndex(papers), graph = buildGraph(index, ['W0'], meta);
    // W998 cites the origin without similarity evidence: shown, unlike the unrelated W999.
    assert.equal(graph.nodes.length, Math.min(size + 1, 40));
    assert.ok(graph.nodes.some(p => p.id === 'W998') && !graph.nodes.some(p => p.id === 'W999'));
    assert.deepEqual(graph, bruteGraph(bruteIndex(papers), ['W0']));
    assert.equal(index.pairs, graph.nodes.length * (graph.nodes.length - 1) / 2);
    assert.equal(new Set(index.anchors).size, index.anchors.length, 'Anchors are accumulated at most once');
    assert.ok(index.anchors.every(id => graph.nodes.some(p => p.id === id)), 'Unselected candidates are never scored as anchors');
    assert.ok(index.anchors.length <= graph.nodes.length);
    if (graph.nodes.length < 35) assert.match(graph.meta.warning!, /no artificial edges/);
    else assert.equal(graph.meta.warning, undefined);
  }
  const graph = buildGraph([paper('W1'), paper('W2', ['W1']), paper('W3', ['external'])], ['W1', 'W3'], meta);
  assert.deepEqual(graph.nodes.map(p => p.id), ['W1', 'W3', 'W2']);
  assert.deepEqual(graph.edges, [{ source: 'W1', target: 'W2', weight: 0, sharedReferences: 0, coCitations: 0, directCitation: true }]);
  const branching = [paper('W1'), paper('W2'), paper('W3'), paper('W4', [], 5), paper('W5', [], 10),
    paper('W10', ['W1', 'W2']), paper('W11', ['W2', 'W3']), paper('W12', ['W3', 'W4']),
    paper('W13', ['W3', 'W5']), paper('W14', ['W1'])];
  const sparse = buildGraph(branching, ['W1'], meta);
  assert.deepEqual(sparse, bruteGraph(bruteIndex(branching), ['W1']));
  assert.ok(sparse.nodes.some(p => p.id === 'W5' && p.similarity === 0 && p.coCitations === 0));
  assert.throws(() => buildGraph([paper('W1')], ['W1', 'W1'], meta), /origin is missing/);
  assert.throws(() => buildGraph([paper('W1')], [], meta), /origin is missing/);
  assert.throws(() => buildGraph([paper('W1')], ['W2'], meta), /origin is missing/);
});

test('co-citation denominators include all candidate citers, even those not displayed', () => {
  const papers = [paper('W1'), paper('W2'), paper('W3', ['W1', 'W2']),
    ...Array.from({ length: 1000 }, (_, i) => paper(`W${i + 4}`, ['W1']))];
  const graph = buildGraph(papers, ['W1'], meta);
  assert.ok(graph.nodes.some(p => p.id === 'W2'));
  const pair = graph.edges.find(e => [e.source, e.target].sort().join() === 'W1,W2')!;
  assert.equal(pair.weight, 1 / (2 * Math.sqrt(1001)));
  assert.equal(graph.meta.candidateCount, 1003);
  assert.equal(graph.derivative[0].id, 'W3');
  assert.equal(graph.derivative[0].graphConnections, 2);
});

test('prior/derivative rankings count unique nonself references, retain evidence and cap at 20', () => {
  const papers = [paper('W1', ['W1', 'W90', 'W90']), paper('W2', ['W90']), paper('W90'),
    ...Array.from({ length: 25 }, (_, i) => paper(`W${100 + i}`, ['W1', 'W2', 'W2'], i))];
  const graph = buildGraph(papers, ['W1'], meta);
  // The 25 citers of W1 are now shown, so W2 (cited by each, once) outranks W90.
  assert.deepEqual(graph.prior.map(p => [p.id, p.graphConnections]), [['W2', 25], ['W90', 2]]);
  assert.equal(graph.derivative.length, 20);
  assert.equal(graph.derivative[0].id, 'W124');
  assert.ok(graph.derivative.every(p => p.graphConnections === 2));
  assert.deepEqual(graph, buildGraph(bruteIndex(papers), ['W1'], meta));
  const manyPrior = Array.from({ length: 25 }, (_, i) => paper(`W${i + 10}`, [], i));
  const priorGraph = buildGraph([paper('W1', manyPrior.map(p => p.id)), paper('W2', manyPrior.map(p => p.id)), ...manyPrior], ['W1'], meta);
  assert.equal(priorGraph.prior.length, 20);
  assert.equal(priorGraph.prior[0].id, 'W34');
});

function components(ids: string[], edges: GraphEdge[]): string[][] {
  const parent = new Map(ids.map(id => [id, id]));
  const root = (id: string): string => parent.get(id) === id ? id : root(parent.get(id)!);
  for (const edge of edges) parent.set(root(edge.source), root(edge.target));
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const r = root(id);
    groups.set(r, [...(groups.get(r) ?? []), id]);
  }
  return [...groups.values()].map(group => group.sort()).sort((a, b) => a[0].localeCompare(b[0]));
}

test('pruneEdges preserves union-of-four semantics, density, components, weak forest bridges and input order', () => {
  const ids = Array.from({ length: 25 }, (_, i) => `W${i}`);
  const edges: GraphEdge[] = [];
  for (const group of [ids.slice(0, 10), ids.slice(10, 20), ids.slice(20, 24)]) {
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      edges.push({ source: group[i], target: group[j], weight: 1, sharedReferences: 2, coCitations: 0 });
    }
  }
  const bridge = { source: ids[9], target: ids[19], weight: 0.01, sharedReferences: 1, coCitations: 0 };
  edges.push(bridge);
  const original = structuredClone(edges), kept = pruneEdges(ids, edges);
  assert.deepEqual(edges, original, 'SQL projection inputs are not mutated');
  assert.deepEqual(components(ids, kept), components(ids, edges));
  assert.ok(kept.includes(bridge), 'Maximum forest preserves a bridge below both endpoints\' top four');
  assert.ok(kept.length < edges.length);
  const sorted = [...edges].sort((a, b) => b.weight - a.weight || a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  for (const id of ids) {
    for (const edge of sorted.filter(e => e.source === id || e.target === id).slice(0, 4)) assert.ok(kept.includes(edge));
  }
  const hubEdge = edges.find(e => e.source === 'W0' && e.target === 'W9')!;
  assert.ok(kept.includes(hubEdge), 'Union, not intersection: an endpoint\'s top four survives a saturated hub');
  assert.deepEqual(kept, edges.filter(edge => kept.includes(edge)), 'Retain caller-supplied ordering');
  assert.deepEqual(pruneEdges(ids, kept), kept);
  assert.deepEqual(pruneEdges(ids, []), []);
  assert.deepEqual(pruneEdges(ids, [...edges].reverse()).map(e => `${e.source}:${e.target}`).sort(), kept.map(e => `${e.source}:${e.target}`).sort());
  const isolated = buildGraph(Array.from({ length: 24 }, (_, i) => paper(`W${i}`, [`field-${Math.floor(i / 8)}`])),
    ['W0', 'W8', 'W16'], meta);
  assert.equal(isolated.nodes.length, 24);
  assert.equal(components(isolated.nodes.map(p => p.id), isolated.edges).length, 3, 'Never connect unrelated origin components');
});

test('index rejects excess resources descriptively without truncation and deduplicates last-record-wins', () => {
  const first = paper('W1', ['old']), last = paper('W1', ['new']);
  const index = new ReferenceIndex([first, paper('W2', ['new']), last]);
  assert.equal(index.size, 2);
  assert.equal(index.paper('W1'), last);
  assert.deepEqual([...index.papers()], [last, paper('W2', ['new'])]);
  assert.equal(index.evidence('W1', 'W2').weight, 0.5);
  assert.equal(buildGraph([first, paper('W2'), last], ['W1'], meta).meta.candidateCount, 2);
  assert.throws(() => new ReferenceIndex(Array.from({ length: 50_001 }, (_, i) => paper(`W${i}`))), /50,000 unique candidate papers/);
  const refs = Array.from({ length: 2001 }, (_, i) => `external-${i}`);
  assert.throws(() => buildGraph(Array.from({ length: 1000 }, (_, i) => paper(`W${i}`, refs)), ['W0'], meta), /2,000,000 reference entries/);
});

test('50k unique candidates are not truncated; late origins and neighbors survive', () => {
  const papers = Array.from({ length: 50_000 }, (_, i) => paper(`W${i}`, i >= 49_990 ? ['external'] : []));
  papers.push(paper('W0', ['external']));
  const graph = buildGraph(papers, ['W49999'], meta);
  assert.equal(graph.meta.candidateCount, 50_000);
  assert.equal(graph.nodes.length, 11);
  assert.ok(graph.nodes.some(p => p.id === 'W49999' && p.isOrigin));
  assert.ok(graph.nodes.some(p => p.id === 'W0' && p.sharedReferences === 1));
  assert.ok(graph.nodes.some(p => p.id === 'W49998'));
});

test('synthetic 1k/10k/50k benchmark: exact 2M-reference boundary, dense ranking and bounded projection', {
  skip: process.env.GRAPH_BENCHMARK !== '1',
}, t => {
  for (const size of [1000, 10_000, 50_000]) {
    globalThis.gc?.();
    const before = process.memoryUsage();
    const start = performance.now();
    const papers = Array.from({ length: size }, (_, i) => paper(`W${i}`, Array.from({ length: 40 }, (_, j) =>
      j < 20 ? `common-${j}` : `field-${i % 100}-${j}`), i));
    const generated = performance.now();
    const index = new CountingIndex(papers);
    const indexed = performance.now(), indexMemory = process.memoryUsage();
    const origins = [`W${size - 1}`, `W${size - 2}`, `W${size - 3}`];
    const graph = buildGraph(index, origins, meta);
    const end = performance.now(), after = process.memoryUsage();
    assert.equal(graph.meta.candidateCount, size);
    assert.equal(graph.nodes.length, 40);
    assert.equal(graph.nodes.filter(p => p.isOrigin).length, 3);
    assert.deepEqual(index.anchors, origins);
    assert.equal(index.pairs, 780);
    assert.equal(index.scores(origins[0]).size, size - 1, 'Rank all candidates, including those beyond 900');
    assert.equal(index.evidence(origins[0], 'W0').weight, 0.25);
    assert.ok(graph.edges.length < 40 * 39 / 4);
    assert.equal(components(graph.nodes.map(p => p.id), graph.edges).length, 1);
    t.diagnostic(JSON.stringify({ kind: 'synthetic scalability only; not measured research relevance', candidates: size,
      referenceEntries: size * 40, generationMs: +(generated - start).toFixed(1), indexMs: +(indexed - generated).toFixed(1),
      buildMs: +(end - indexed).toFixed(1), totalMs: +(end - start).toFixed(1), nodes: graph.nodes.length, edges: graph.edges.length,
      exactPairs: 780, scoreAnchors: 3, indexHeapDeltaMiB: +((indexMemory.heapUsed - before.heapUsed) / 2 ** 20).toFixed(1),
      totalHeapDeltaMiB: +((after.heapUsed - before.heapUsed) / 2 ** 20).toFixed(1), rssMiB: +(after.rss / 2 ** 20).toFixed(1),
      gcExposed: !!globalThis.gc }));
  }
});
