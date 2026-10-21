import type { Page } from '@playwright/test';
import type { GraphPaper, GraphResponse } from '../shared/types';
import { GraphResponseSchema } from '../shared/schemas';
import { layoutGraph, nodeRadius } from '../src/components/graphLayout';
import featuredPreviews from '../src/featured-previews.json' with { type: 'json' };
import { test, expect, nodes, details, graphPapers, openGraph, selectPaper } from './fixtures';

// Synthetic relation contracts only, not provider metadata or ranking fixtures.
const paper = (id: string, references: string[] = [], similarity = 0, isOrigin = false): GraphPaper => ({
  id, title: `Synthetic relation fixture ${id} (not a publication)`, authors: ['UI fixture author'],
  year: null, venue: 'Synthetic UI fixture', citations: 0, references,
  abstract: 'Synthetic data for citation and similarity UI contracts only.', doi: null,
  url: `https://openalex.org/${id}`, pdfUrl: null, openAccess: false, topics: [],
  similarity, isOrigin, sharedReferences: similarity > 0 && !isOrigin ? 1 : 0, coCitations: 0, graphConnections: 0,
});
const edge = (source: string, target: string, weight = 0): GraphResponse['edges'][number] => ({
  source, target, weight, sharedReferences: weight > 0 ? 1 : 0, coCitations: 0,
  ...(weight === 0 ? { directCitation: true } : {}),
});

async function relationGraph(page: Page, papers: GraphPaper[], edges: GraphResponse['edges']) {
  const graph = GraphResponseSchema.parse({
    origins: papers.filter(p => p.isOrigin).map(p => p.id), nodes: papers, edges, prior: [], derivative: [],
    meta: { source: 'snapshot', fetchedAt: '2026-10-13T00:00:00.000Z', candidateCount: papers.length,
      algorithm: 'Synthetic relation UI contract', coverage: 'Not a real literature graph.' },
  });
  await page.route('**/api/graph?*', route => route.fulfill({ json: graph }));
  await openGraph(page, graph.origins.join(','));
  return graph;
}

test('zero origin scores distinguish both citation directions, other origins and indirect neighbors', async ({ page }) => {
  const origin = paper('W1001', ['W1002', 'W1006'], 1, true);
  const cited = paper('W1002');
  const citing = paper('W1003', [origin.id]);
  const indirect = paper('W1004');
  const otherOrigin = paper('W1005', ['W1007'], 1, true);
  const scoredCitation = paper('W1006', [], 0.25);
  const otherCited = paper('W1007');
  await relationGraph(page, [origin, cited, citing, indirect, otherOrigin, scoredCitation, otherCited], [
    edge(origin.id, cited.id), edge(origin.id, citing.id), edge(cited.id, indirect.id, 0.2),
    edge(origin.id, scoredCitation.id, 0.25), edge(otherOrigin.id, otherCited.id),
  ]);
  for (const candidate of [cited, citing, otherCited]) {
    await expect(graphPapers(page).getByRole('button').filter({ hasText: candidate.title }).locator('.sidebar-score')).toHaveText('Direct citation');
  }
  await expect(graphPapers(page).getByRole('button').filter({ hasText: indirect.title }).locator('.sidebar-score')).toHaveText('No measured origin similarity');
  await expect(graphPapers(page).getByRole('button').filter({ hasText: scoredCitation.title }).locator('.sidebar-score')).toHaveText('25.0% similarity');
});

test('citation-only edges stay dashed and never become a similarity step', async ({ page }) => {
  const origin = paper('W1101', ['W1102'], 1, true), cited = paper('W1102');
  await relationGraph(page, [origin, cited], [edge(origin.id, cited.id)]);
  await selectPaper(page, cited);
  await expect(page.locator('.graph-selection-detail')).toHaveText('No similarity path to an origin in this graph.');
  await expect(page.locator('.graph-edge--path')).toHaveCount(0);
  await expect(page.locator('.graph-edge--direct')).toHaveCSS('stroke-dasharray', '4px, 3px');
  await expect(page.locator('.graph-svg')).toHaveAttribute('aria-label', '2 papers and 1 connections (similarity and citation)');
  await page.getByRole('button', { name: 'How to read and navigate the graph' }).click();
  await expect(page.getByRole('region', { name: 'How to read the graph', exact: true })).toContainText('Citation-only dashed lines are excluded from similarity paths.');
});

test('singleton graphs explain missing connections without blaming rendering or filters', async ({ page }) => {
  await relationGraph(page, [paper('W1199', [], 1, true)], []);
  await expect(nodes(page)).toHaveCount(1);
  const notice = page.getByRole('region', { name: 'Limited graph connections', exact: true });
  await expect(notice).toContainText('No indexed connections available');
  await notice.getByRole('button', { name: 'Review coverage', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Data & coverage', exact: true })).toContainText('Not a real literature graph.');
});

test('a zero-score indirect neighbor has no route through a citation bridge but retains a real similarity route', async ({ page }) => {
  const origin = paper('W1201', ['W1202'], 1, true), bridge = paper('W1202'), indirect = paper('W1203');
  const graph = await relationGraph(page, [origin, bridge, indirect], [edge(origin.id, bridge.id), edge(bridge.id, indirect.id, 0.3)]);
  await selectPaper(page, indirect);
  await expect(page.locator('.graph-selection-detail')).toHaveText('No similarity path to an origin in this graph.');
  await expect(page.locator('.graph-edge--path')).toHaveCount(0);

  const similar = paper('W1204', [], 0.2);
  graph.nodes.push(similar);
  graph.edges.push(edge(origin.id, similar.id, 0.2), edge(similar.id, indirect.id, 0.2));
  GraphResponseSchema.parse(graph);
  await page.reload();
  await expect(nodes(page)).toHaveCount(4);
  await expect(page.locator('.graph-selection-detail')).toHaveText('2 similarity steps to the nearest origin.');
  await expect(page.locator('.graph-edge--path')).toHaveCount(2);
  await expect(page.locator('.graph-edge--direct.graph-edge--path')).toHaveCount(0);
});

test('hover details add the displayed paper as an origin without changing selection first', async ({ page }) => {
  const graph = await openGraph(page);
  const origin = graph.nodes.find(p => p.isOrigin)!;
  const hovered = graph.nodes.find(p => !p.isOrigin)!;
  const disc = page.locator(`g[data-paper-id="${hovered.id}"] .graph-node-disc`);
  await disc.hover();
  await expect(details(page).getByRole('heading', { name: hovered.title, exact: true })).toBeVisible();
  await expect(page.locator('.graph-selection-title')).toHaveText(origin.title);
  await expect(page).toHaveURL(url => !url.searchParams.has('selected'));
  await page.mouse.move(2, 2);
  await expect(details(page).getByRole('heading', { name: origin.title, exact: true })).toBeVisible();
  await disc.hover();
  const add = details(page).getByRole('button', { name: 'Add origin', exact: true });
  await add.focus();
  await expect(details(page).getByRole('heading', { name: hovered.title, exact: true })).toBeVisible();
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/graph');
  // Keyboard activation keeps the pointer on the hover preview, unlike moving it to the sidebar.
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(url => url.pathname === `/graph/${origin.id},${hovered.id}/graph`);
  const combined = GraphResponseSchema.parse(await (await response).json());
  expect(combined.origins).toEqual([origin.id, hovered.id]);
  await expect(page.locator('.graph-node--origin')).toHaveCount(2);
});

test('layout positions are invariant to node order, edge order and endpoint orientation', () => {
  const positions = (reversed: boolean) => {
    const nodes = ['W1301', 'W1302', 'W1303', 'W1304'].map((id, i) => ({ id, radius: 7 + i, x: NaN, y: NaN }));
    const byId = new Map(nodes.map(n => [n.id, n]));
    const edges = [edge('W1301', 'W1302'), edge('W1302', 'W1303', 0.2), edge('W1301', 'W1304', 0.3)]
      .map(e => ({ source: byId.get(e.source)!, target: byId.get(e.target)!, weight: e.weight, direct: e.directCitation === true }));
    if (reversed) {
      nodes.reverse(); edges.reverse();
      for (const e of edges) [e.source, e.target] = [e.target, e.source];
    }
    layoutGraph(nodes, edges).stop();
    return nodes.map(n => ({ id: n.id, x: n.x, y: n.y })).sort((a, b) => a.id.localeCompare(b.id));
  };
  expect(positions(true)).toEqual(positions(false));
});

test('all bundled previews match the actual offline canvas geometry', async ({ page }) => {
  for (const preview of featuredPreviews) {
    const graph = await openGraph(page, preview.id);
    const maxCitations = Math.max(1, ...graph.nodes.map(p => p.citations));
    const positions = await nodes(page).evaluateAll(elements => elements.map(element => {
      const [x, y] = element.getAttribute('transform')!.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g)!.map(Number);
      return { id: element.getAttribute('data-paper-id')!, x, y };
    }));
    const layout = positions.map(n => ({ ...n, radius: nodeRadius(graph.nodes.find(p => p.id === n.id)!.citations, maxCitations) }));
    const left = Math.min(...layout.map(n => n.x - n.radius)), right = Math.max(...layout.map(n => n.x + n.radius));
    const top = Math.min(...layout.map(n => n.y - n.radius)), bottom = Math.max(...layout.map(n => n.y + n.radius));
    const scale = Math.min(304 / (right - left), 204 / (bottom - top));
    const offsetX = (320 - (right - left) * scale) / 2 - left * scale;
    const offsetY = (220 - (bottom - top) * scale) / 2 - top * scale;
    const round = (value: number) => Math.round(value * 10) / 10;
    const sorted = [...layout].sort((a, b) => a.id.localeCompare(b.id));
    expect(preview.nodes.map(n => [n.x, n.y, n.r])).toEqual(sorted.map(n => [
      round(n.x * scale + offsetX), round(n.y * scale + offsetY), round(Math.max(1.5, n.radius * scale)),
    ]));
    const indices = new Map(sorted.map((n, i) => [n.id, i]));
    const maxWeight = Math.max(0.001, ...graph.edges.map(e => e.weight));
    const pairs = graph.edges.map(e => [
      Math.min(indices.get(e.source)!, indices.get(e.target)!), Math.max(indices.get(e.source)!, indices.get(e.target)!), round(e.weight / maxWeight),
    ]).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    expect(preview.edges).toEqual(pairs);
  }
});
