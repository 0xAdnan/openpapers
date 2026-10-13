import type { GraphEdge, GraphPaper, GraphResponse, Paper } from '../shared/types.ts';
import { ReferenceIndex, type EdgeEvidence, type GraphIndex } from './indexed-scoring.ts';

export const ALGORITHM = 'indexed-v2: weight = (sharedReferences / sqrt(referenceCountA * referenceCountB) + observedCoCiters / sqrt(observedCiterCountA * observedCiterCountB)) / 2; zero denominators contribute 0. Exact reference-posting accumulation for origins and selected-neighbor expansion, then at most 780 exact displayed pairs. Co-citation uses only fetched candidate records (sample-local). No topic or direct-citation fallback edges. Each origin reserves slots for papers it cites or is cited by that have positive evidence. Displayed edges: union of each paper\'s 4 strongest plus a maximum spanning forest.';

// Nearly every pair of papers in an overlapping neighborhood shares some evidence,
// so drawing all of them yields a near-complete graph. Keep each paper's strongest
// links, plus a maximum spanning forest so connected papers stay connected.
const STRONGEST_PER_PAPER = 4;

// Supplied edges must be unique positive-evidence pairs with both endpoints in ids.
// Preserve input order and leave the caller's projection untouched.
export function pruneEdges(ids: string[], edges: GraphEdge[]): GraphEdge[] {
  const byStrength = [...edges].sort((a, b) => b.weight - a.weight
    || a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  const kept = new Set<GraphEdge>();
  const perPaper = new Map(ids.map(id => [id, 0]));
  for (const edge of byStrength) {
    if (perPaper.get(edge.source)! < STRONGEST_PER_PAPER || perPaper.get(edge.target)! < STRONGEST_PER_PAPER) kept.add(edge);
    perPaper.set(edge.source, perPaper.get(edge.source)! + 1);
    perPaper.set(edge.target, perPaper.get(edge.target)! + 1);
  }
  const parent = new Map(ids.map(id => [id, id]));
  const root = (id: string): string => {
    while (parent.get(id) !== id) id = parent.get(id)!;
    return id;
  };
  for (const edge of byStrength) {
    const a = root(edge.source), b = root(edge.target);
    if (a === b) continue;
    parent.set(a, b);
    kept.add(edge);
  }
  return edges.filter(edge => kept.has(edge));
}

export function buildGraph(papers: Paper[] | GraphIndex, origins: string[], meta: GraphResponse['meta']): GraphResponse {
  const index = Array.isArray(papers) ? new ReferenceIndex(papers) : papers;
  if (index.size > 50_000) throw new RangeError('Graph index exceeds the limit of 50,000 unique candidate papers');
  if (!origins.length || origins.length > 3 || new Set(origins).size !== origins.length || origins.some(id => !index.paper(id))) throw new Error('Graph origin is missing');
  const empty: EdgeEvidence = { weight: 0, sharedReferences: 0, coCitations: 0 };
  const originScores = new Map<string, EdgeEvidence>();
  const perOrigin = new Map(origins.map(id => [id, index.scores(id)]));
  for (const scores of perOrigin.values()) {
    for (const [id, evidence] of scores) {
      if (evidence.weight > (originScores.get(id)?.weight ?? 0)) originScores.set(id, evidence);
    }
  }
  const chosen = new Set(origins);
  const candidateRank = (a: Paper, b: Paper) =>
    (originScores.get(b.id)?.weight ?? 0) - (originScores.get(a.id)?.weight ?? 0) || b.citations - a.citations || a.id.localeCompare(b.id);
  const candidates = [...originScores.keys()].filter(id => !chosen.has(id)).map(id => index.paper(id)!).sort(candidateRank);
  // Papers an origin cites or is cited by are the context readers expect, but sparse
  // reference lists can score them just below stronger strangers. Reserve them slots
  // when they have positive similarity evidence; no direct-citation edges are invented.
  const directSlots = Math.min(8, Math.floor((40 - origins.length) / (2 * origins.length)));
  for (const origin of origins) {
    const references = new Set(index.paper(origin)!.references);
    const direct = [...perOrigin.get(origin)!].filter(([id]) => !origins.includes(id)
      && (references.has(id) || index.paper(id)!.references.includes(origin)))
      .sort((a, b) => b[1].weight - a[1].weight || a[0].localeCompare(b[0])).slice(0, directSlots);
    for (const [id] of direct) chosen.add(id);
  }
  // Give each origin a small foothold, so multi-origin graphs do not lose a field.
  for (const origin of origins) {
    const neighbors = [...perOrigin.get(origin)!].filter(([id]) => !origins.includes(id))
      .sort((a, b) => b[1].weight - a[1].weight || a[0].localeCompare(b[0])).slice(0, 8);
    for (const [id] of neighbors) chosen.add(id);
  }
  for (const p of candidates) {
    if (chosen.size >= 40) break;
    chosen.add(p.id);
  }
  // Sparse data may yield fewer than 40 nodes; only add evidence-connected neighbors.
  if (chosen.size < 40) {
    const frontier = new Map<string, number>();
    const expand = (id: string) => {
      for (const [neighbor, evidence] of perOrigin.get(id) ?? index.scores(id)) {
        if (!chosen.has(neighbor) && evidence.weight > (frontier.get(neighbor) ?? 0)) frontier.set(neighbor, evidence.weight);
      }
    };
    for (const id of chosen) expand(id);
    while (chosen.size < 40 && frontier.size) {
      let best: Paper | undefined, bestWeight = 0;
      for (const [id, weight] of frontier) {
        const paper = index.paper(id)!;
        if (weight > bestWeight || (weight === bestWeight && best && candidateRank(paper, best) < 0)) {
          best = paper; bestWeight = weight;
        }
      }
      if (!best) break;
      chosen.add(best.id);
      frontier.delete(best.id);
      if (chosen.size < 40) expand(best.id);
    }
  }
  const ids = [...chosen];
  const evidenced: GraphEdge[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const evidence = index.evidence(ids[i], ids[j]);
      if (evidence.weight > 0) evidenced.push({ source: ids[i], target: ids[j], ...evidence });
    }
  }
  const edges = pruneEdges(ids, evidenced);
  const degrees = new Map(ids.map(id => [id, 0]));
  for (const edge of edges) {
    degrees.set(edge.source, degrees.get(edge.source)! + 1);
    degrees.set(edge.target, degrees.get(edge.target)! + 1);
  }
  const decorate = (p: Paper, graphConnections = degrees.get(p.id) ?? 0): GraphPaper => {
    const evidence = originScores.get(p.id) ?? empty;
    return { ...p, similarity: origins.includes(p.id) ? 1 : evidence.weight,
      sharedReferences: evidence.sharedReferences, coCitations: evidence.coCitations,
      graphConnections, isOrigin: origins.includes(p.id) };
  };
  const nodes = ids.map(id => decorate(index.paper(id)!)).sort((a, b) =>
    Number(b.isOrigin) - Number(a.isOrigin) || b.similarity - a.similarity || a.id.localeCompare(b.id));
  const rank = (a: GraphPaper, b: GraphPaper) => b.graphConnections - a.graphConnections || b.citations - a.citations || a.id.localeCompare(b.id);
  const prior = index.prior(ids).filter(p => !origins.includes(p.id))
    .map(p => decorate(index.paper(p.id)!, p.graphConnections)).sort(rank).slice(0, 20);
  const derivative: GraphPaper[] = [];
  for (const paper of index.papers()) {
    if (origins.includes(paper.id)) continue;
    let count = 0;
    for (const reference of new Set(paper.references)) if (reference !== paper.id && chosen.has(reference)) count++;
    if (count >= 2) derivative.push(decorate(paper, count));
  }
  derivative.sort(rank);
  return { origins: [...origins], nodes, edges, prior, derivative: derivative.slice(0, 20),
    meta: { ...meta, candidateCount: index.size, algorithm: ALGORITHM,
      ...(nodes.length < 35 ? { warning: [meta.warning, `Only ${nodes.length} evidence-connected nodes were available; no artificial edges were added.`].filter(Boolean).join(' ') } : {}) } };
}
