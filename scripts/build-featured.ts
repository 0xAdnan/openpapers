import { readFile, writeFile } from 'node:fs/promises';
import type { CandidatePool } from '../server/collection.ts';
import { buildGraph } from '../server/graph.ts';
import { CandidatePoolSchema } from '../shared/schemas.ts';
import { layoutGraph, nodeRadius, type LayoutNodeInput } from '../src/components/graphLayout.ts';

// Regenerate thumbnails from the genuine bundled pools, without acquiring data or renewing provenance.
const FEATURED = ['W2108680868', 'W2501369945', 'W1980536550'];
const WIDTH = 320, HEIGHT = 220, PAD = 8;

const snapshot: { version: number; provider: string; pools: CandidatePool[] } = JSON.parse(await readFile('data/featured.json', 'utf8'));
if (snapshot.version !== 1 || snapshot.provider !== 'https://api.openalex.org' || !Array.isArray(snapshot.pools)) {
  throw new Error('Invalid bundled featured snapshot');
}
const previews = [];
for (const id of FEATURED) {
  const pool = CandidatePoolSchema.parse(snapshot.pools.find(pool => pool.origin === id));
  const graph = buildGraph(pool.papers, [id], { source: pool.source, fetchedAt: pool.fetchedAt, candidateCount: 0, algorithm: '', coverage: pool.coverage });
  const maxCitations = Math.max(1, ...graph.nodes.map(p => p.citations));
  const nodes: (LayoutNodeInput & { x: number; y: number })[] = graph.nodes.map(p => ({ id: p.id, radius: nodeRadius(p.citations, maxCitations), x: NaN, y: NaN }));
  const byId = new Map(nodes.map(n => [n.id, n]));
  const edges = graph.edges.map(e => ({ source: byId.get(e.source)!, target: byId.get(e.target)!, weight: e.weight, direct: e.directCitation === true }));
  layoutGraph(nodes, edges);
  const left = Math.min(...nodes.map(n => n.x - n.radius)), right = Math.max(...nodes.map(n => n.x + n.radius));
  const top = Math.min(...nodes.map(n => n.y - n.radius)), bottom = Math.max(...nodes.map(n => n.y + n.radius));
  const scale = Math.min((WIDTH - 2 * PAD) / (right - left), (HEIGHT - 2 * PAD) / (bottom - top));
  const offsetX = (WIDTH - (right - left) * scale) / 2 - left * scale, offsetY = (HEIGHT - (bottom - top) * scale) / 2 - top * scale;
  const years = graph.nodes.flatMap(p => p.year === null ? [] : [p.year]);
  const first = Math.min(...years), last = Math.max(...years);
  const round = (value: number) => Math.round(value * 10) / 10;
  const origin = graph.nodes.find(p => p.isOrigin)!;
  const maxWeight = Math.max(0.001, ...graph.edges.map(e => e.weight));
  previews.push({
    id, title: origin.title, author: origin.authors[0]?.trim().split(/\s+/).at(-1) ?? 'Unknown', year: origin.year,
    nodes: nodes.map(n => {
      const paper = graph.nodes.find(p => p.id === n.id)!;
      return { x: round(n.x * scale + offsetX), y: round(n.y * scale + offsetY), r: round(Math.max(1.5, n.radius * scale)),
        year: paper.year === null ? null : round((paper.year - first) / Math.max(1, last - first)),
        label: `${paper.authors[0]?.trim().split(/\s+/).at(-1) || 'Unknown'}, ${paper.year ?? 'n.d.'}`, origin: paper.isOrigin };
    }),
    edges: edges.map(e => [nodes.indexOf(e.source), nodes.indexOf(e.target), round(e.weight / maxWeight)]),
  });
  console.info(`${id}: ${pool.papers.length} candidates, ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
}
await writeFile('src/featured-previews.json', `${JSON.stringify(previews)}\n`);
