import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
} from 'd3-force';
import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from 'd3-force';

// Shared by the interactive graph and the prebuilt homepage previews, so both look alike.

export interface LayoutNodeInput extends SimulationNodeDatum {
  id: string;
  radius: number;
}

export interface LayoutEdgeInput<N extends LayoutNodeInput> extends SimulationLinkDatum<N> {
  source: N;
  target: N;
  weight: number;
  direct: boolean;
}

export function nodeRadius(citations: number, maxCitations: number): number {
  return 7 + 23 * Math.log1p(citations) / Math.log1p(Math.max(1, maxCitations));
}

// Pale teal for the oldest year in the graph, dark teal for the newest; gray-teal when unknown.
export function yearColor(ratio: number | null): string {
  if (ratio === null) return '#b4c9ca';
  return `rgb(${Math.round(178 - 162 * ratio)}, ${Math.round(204 - 126 * ratio)}, ${Math.round(204 - 122 * ratio)})`;
}

// d3-force's default random source is seeded. Sorted inputs make layouts reproducible.
// Strong links pull hard and short; weak links are long and slack, so similar papers
// cluster and weakly related ones drift outward. Collision only prevents disc overlap:
// reserving label width spreads nodes evenly and hides the similarity structure.
export function layoutGraph<N extends LayoutNodeInput, E extends LayoutEdgeInput<N>>(nodes: N[], edges: E[]): Simulation<N, E> {
  // Canonicalize before d3 assigns initial positions or accumulates link forces.
  nodes.sort((a, b) => a.id.localeCompare(b.id));
  for (const edge of edges) {
    if (edge.source.id > edge.target.id) [edge.source, edge.target] = [edge.target, edge.source];
  }
  edges.sort((a, b) => a.source.id.localeCompare(b.source.id) || a.target.id.localeCompare(b.target.id)
    || a.weight - b.weight || Number(a.direct) - Number(b.direct));
  const maxWeight = Math.max(0.001, ...edges.map((edge) => edge.weight));
  const simulation = forceSimulation<N>(nodes)
    .force('link', forceLink<N, E>(edges)
      .id((node) => node.id)
      .distance((edge) => edge.source.radius + edge.target.radius + 15 + 60 * (1 - edge.weight / maxWeight))
      // Direct-citation links carry no similarity: a gentle pull keeps them on the periphery.
      .strength((edge) => edge.direct ? 0.15 : (edge.weight / maxWeight) ** 2))
    .force('charge', forceManyBody<N>().strength(-120))
    .force('center', forceCenter(0, 0))
    .force('collision', forceCollide<N>()
      .radius((node) => node.radius + 3)
      .iterations(4))
    .stop();
  simulation.tick(280);
  return simulation;
}
