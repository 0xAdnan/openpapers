import type { GraphEdge, GraphPaper, GraphResponse, Paper } from '../shared/types.ts';

export const ALGORITHM = 'weight = (sharedReferences / sqrt(referenceCountA * referenceCountB) + observedCoCiters / sqrt(observedCiterCountA * observedCiterCountB)) / 2; zero denominators contribute 0. Co-citation uses only fetched candidate records. No topic or direct-citation fallback edges.';

export function buildGraph(papers: Paper[], origins: string[], meta: GraphResponse['meta']): GraphResponse {
  const unique = new Map(papers.slice(0, 900).map(p => [p.id, p]));
  if (!origins.length || origins.length > 3 || origins.some(id => !unique.has(id))) throw new Error('Graph origin is missing');
  const refs = new Map([...unique.values()].map(p => [p.id, new Set(p.references.filter(id => id !== p.id))]));
  const citers = new Map([...unique.keys()].map(id => [id, new Set<string>()]));
  for (const [id, references] of refs) {
    for (const reference of references) citers.get(reference)?.add(id);
  }
  const overlap = (a: Set<string>, b: Set<string>) => {
    let count = 0;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    for (const id of small) if (large.has(id)) count++;
    return count;
  };
  const scores = new Map<string, Omit<GraphEdge, 'source' | 'target'>>();
  const score = (a: string, b: string) => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const cached = scores.get(key);
    if (cached) return cached;
    const ra = refs.get(a)!, rb = refs.get(b)!;
    const ca = citers.get(a)!, cb = citers.get(b)!;
    const sharedReferences = overlap(ra, rb), coCitations = overlap(ca, cb);
    const coupling = ra.size && rb.size ? sharedReferences / Math.sqrt(ra.size * rb.size) : 0;
    const cocitation = ca.size && cb.size ? coCitations / Math.sqrt(ca.size * cb.size) : 0;
    const result = { weight: (coupling + cocitation) / 2, sharedReferences, coCitations };
    scores.set(key, result);
    return result;
  };
  const originScores = new Map([...unique.keys()].map(id => {
    let strongest = { weight: 0, sharedReferences: 0, coCitations: 0 };
    for (const origin of origins) {
      if (origin === id) continue;
      const next = score(id, origin);
      if (next.weight > strongest.weight) strongest = next;
    }
    return [id, strongest] as const;
  }));
  const chosen = new Set(origins);
  const candidates = [...unique.values()].filter(p => !chosen.has(p.id)).sort((a, b) =>
    originScores.get(b.id)!.weight - originScores.get(a.id)!.weight || b.citations - a.citations || a.id.localeCompare(b.id));
  // Give each origin a small foothold, so multi-origin graphs do not lose a field.
  for (const origin of origins) {
    const neighbors = candidates.filter(p => score(p.id, origin).weight > 0)
      .sort((a, b) => score(b.id, origin).weight - score(a.id, origin).weight || a.id.localeCompare(b.id)).slice(0, 8);
    for (const p of neighbors) chosen.add(p.id);
  }
  for (const p of candidates) {
    if (chosen.size >= 40) break;
    if (originScores.get(p.id)!.weight > 0) chosen.add(p.id);
  }
  // Sparse data may yield fewer than 40 nodes; only add evidence-connected neighbors.
  while (chosen.size < 40) {
    let best: Paper | undefined, bestWeight = 0;
    for (const p of candidates) {
      if (chosen.has(p.id)) continue;
      for (const neighbor of chosen) {
        const weight = score(p.id, neighbor).weight;
        if (weight > bestWeight) { best = p; bestWeight = weight; }
      }
    }
    if (!best) break;
    chosen.add(best.id);
  }
  const ids = [...chosen];
  const edges: GraphEdge[] = [];
  const degrees = new Map(ids.map(id => [id, 0]));
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const evidence = score(ids[i], ids[j]);
      if (evidence.weight <= 0) continue;
      edges.push({ source: ids[i], target: ids[j], ...evidence });
      degrees.set(ids[i], degrees.get(ids[i])! + 1);
      degrees.set(ids[j], degrees.get(ids[j])! + 1);
    }
  }
  const decorate = (p: Paper, graphConnections = degrees.get(p.id) ?? 0): GraphPaper => {
    const evidence = originScores.get(p.id)!;
    return { ...p, similarity: origins.includes(p.id) ? 1 : evidence.weight,
      sharedReferences: evidence.sharedReferences, coCitations: evidence.coCitations,
      graphConnections, isOrigin: origins.includes(p.id) };
  };
  const nodes = ids.map(id => decorate(unique.get(id)!)).sort((a, b) =>
    Number(b.isOrigin) - Number(a.isOrigin) || b.similarity - a.similarity || a.id.localeCompare(b.id));
  const priorCounts = new Map<string, number>();
  for (const id of ids) {
    for (const reference of refs.get(id)!) priorCounts.set(reference, (priorCounts.get(reference) ?? 0) + 1);
  }
  const rank = (a: GraphPaper, b: GraphPaper) => b.graphConnections - a.graphConnections || b.citations - a.citations || a.id.localeCompare(b.id);
  const prior = [...unique.values()].filter(p => !origins.includes(p.id) && (priorCounts.get(p.id) ?? 0) >= 2)
    .map(p => decorate(p, priorCounts.get(p.id))).sort(rank).slice(0, 20);
  const derivative = [...unique.values()].filter(p => !origins.includes(p.id))
    .map(p => decorate(p, [...refs.get(p.id)!].filter(id => chosen.has(id)).length))
    .filter(p => p.graphConnections >= 2).sort(rank).slice(0, 20);
  return { origins: [...origins], nodes, edges, prior, derivative,
    meta: { ...meta, candidateCount: unique.size, algorithm: ALGORITHM,
      ...(nodes.length < 35 ? { warning: [meta.warning, `Only ${nodes.length} evidence-connected nodes were available; no artificial edges were added.`].filter(Boolean).join(' ') } : {}) } };
}
