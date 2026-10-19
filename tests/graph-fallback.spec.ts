import { test, expect, type Page } from '@playwright/test';
import { GraphJobSchema } from '../shared/graph-jobs';
import { GraphResponseSchema } from '../shared/schemas';
import type { GraphResponse } from '../shared/types';

const W = ['W9000001', 'W9000002'];
const S2 = [1, 2, 3, 4].map(n => `S2:${String(n).padStart(40, '0')}`);
const JOB_ID = '7a9488e2-7425-4b41-96bd-b941419ba3b0';
const jobPath = `/api/graph-jobs/${JOB_ID}`;
const noticeText = 'Showing Semantic Scholar: OpenAlex had limited connection data.';
const config = { available: true, candidateBudget: 5000, maxCandidateBudget: 50000, requestBudget: 100, persistence: 'postgres' };
const notice = (page: Page) => page.getByRole('region', { name: 'Graph data fallback', exact: true });
const nodes = (page: Page) => page.locator('svg.graph-svg g[data-paper-id]');
const details = (page: Page) => page.getByRole('complementary', { name: 'Selected paper details' });
const views = (page: Page) => page.getByRole('navigation', { name: 'Graph views' });

// Explicitly synthetic API projections. These assert UI contracts, not scholarly relevance.
function nativeGraph(origins = [S2[0]]): GraphResponse {
  const graph: GraphResponse = {
    origins,
    nodes: S2.map((id, index) => ({
      id, title: `Synthetic UI fixture ${index + 1} (not a publication)`, authors: ['Fixture Author'],
      year: 2026, venue: 'Synthetic UI fixture', citations: 0, references: index === 2 ? [S2[0]] : [],
      abstract: 'Synthetic browser fixture; no claim about scholarly correctness.', doi: null,
      url: `https://www.semanticscholar.org/paper/${id.slice(3)}`,
      pdfUrl: 'https://example.org/synthetic-fixture.pdf', openAccess: true, topics: [],
      isOrigin: origins.includes(id), similarity: origins.includes(id) ? 1 : index === 2 ? 0 : 0.5,
      sharedReferences: index === 2 ? 0 : 2, coCitations: 0, graphConnections: 1,
    })),
    edges: [
      { source: S2[0], target: S2[2], weight: 0, sharedReferences: 0, coCitations: 0, directCitation: true },
      { source: S2[0], target: S2[3], weight: 0.5, sharedReferences: 2, coCitations: 0 },
      { source: S2[1], target: S2[3], weight: 0.5, sharedReferences: 2, coCitations: 0 },
    ],
    prior: [], derivative: [],
    meta: { source: 'cache', provider: 'semantic-scholar', fetchedAt: '2026-10-19T00:00:00.000Z',
      candidateCount: 4, algorithm: 'synthetic-ui-fixture', coverage: 'Synthetic UI projection, not research metadata.' },
  };
  graph.prior = [graph.nodes[2]];
  graph.derivative = [graph.nodes[3]];
  return GraphResponseSchema.parse(graph);
}

function fallbackGraph(requestedOrigins = [W[0]]): GraphResponse {
  const graph = nativeGraph(S2.slice(0, requestedOrigins.length));
  graph.meta.fallback = {
    from: 'openalex', requestedOrigins, resolvedOrigins: graph.origins, reason: 'limited_connections',
    comparison: { openalex: { nodes: requestedOrigins.length, edges: 0, connectedOrigins: 0, candidates: requestedOrigins.length },
      semanticScholar: { nodes: 4, edges: 3, connectedOrigins: requestedOrigins.length, candidates: 4 } },
  };
  return GraphResponseSchema.parse(graph);
}

function completedJob() {
  const result = GraphResponseSchema.parse({
    origins: [W[0]], nodes: [{ ...nativeGraph().nodes[0], id: W[0], references: [],
      title: 'Synthetic completed OpenAlex job (not a publication)', isOrigin: true }],
    edges: [], prior: [], derivative: [],
    meta: { source: 'cache', provider: 'openalex', fetchedAt: '2026-10-19T00:00:00.000Z',
      candidateCount: 321, algorithm: 'synthetic-job-fixture', coverage: 'Synthetic completed job.' },
  });
  return GraphJobSchema.parse({ id: JOB_ID, origins: [W[0]], state: 'completed', phase: 'publish',
    candidateBudget: 5000, acquiredCount: 321, referenceCount: 1000, referenceBudget: 2000000,
    requestsUsed: 10, requestBudget: 100, createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z', nextRunAt: null, stopReason: null, error: null, result });
}

async function mockConfig(page: Page) {
  let calls = 0;
  await page.route('**/api/graph-jobs/config', route => { calls++; return route.fulfill({ json: config }); });
  return () => calls;
}

test.describe('Graph fallback UI contracts (synthetic API data, not research metadata)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('legacy W origins map by index and share S2 canonical selection and filters without an OA job', async ({ page }) => {
    const graph = fallbackGraph(W);
    let graphCalls = 0;
    await mockConfig(page);
    await page.route('**/api/graph?**', route => {
      graphCalls++;
      expect(new URL(route.request().url()).searchParams.get('ids')).toBe(W.join(','));
      expect(new URL(route.request().url()).searchParams.has('provider')).toBe(false);
      return route.fulfill({ json: graph });
    });
    await page.route(`**${jobPath}`, route => route.fulfill({ json: { ...completedJob(), origins: W, state: 'running', result: null } }));
    const filters = { keyword: 'Synthetic', from: '2026', to: '2026', oa: '1', pdf: '1' };
    const params = new URLSearchParams({ selected: W[1], ...filters, job: JOB_ID, utm_source: 'fixture', token: 'private-fixture' });
    await page.goto(`/graph/${W.join(',')}/graph?${params}`);
    await expect(nodes(page)).toHaveCount(4);
    await expect(page.locator('.graph-origin-ring')).toHaveCount(2);
    await expect(page.locator(`g[data-paper-id="${S2[1]}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(details(page).locator('h2')).toHaveText(graph.nodes[1].title);
    await expect(notice(page)).toContainText(noticeText);
    await expect(notice(page)).toContainText('OpenAlex: 2 papers, 0 edges. Semantic Scholar: 4 papers, 3 edges.');
    await expect(page.locator('.graph-summary .data-badge')).toContainText('Semantic Scholar');
    await expect(page.getByRole('button', { name: 'Expand research', exact: true })).toHaveCount(0);
    await expect(page.getByRole('combobox')).toHaveCount(0);
    await expect(page).toHaveURL(url => url.pathname === `/graph/${W.join(',')}/graph` && url.searchParams.get('selected') === W[1] && url.searchParams.get('job') === JOB_ID);

    for (const label of [/^Prior/, /^Derivative/, /^List/]) await views(page).getByRole('link', { name: label }).click();
    await expect(page.locator('tbody tr.selected .table-title')).toHaveText(graph.nodes[1].title);
    await expect(page).toHaveURL(url => url.pathname === `/graph/${W.join(',')}/list`);
    expect(graphCalls).toBe(1);
    const canonical = new URL((await notice(page).getByRole('link', { name: 'Open canonical graph' }).getAttribute('href'))!);
    expect(canonical.pathname).toBe(`/graph/${graph.origins.join(',')}/list`);
    expect(Object.fromEntries(canonical.searchParams)).toEqual({ selected: S2[1], ...filters });
    await page.getByRole('button', { name: 'Share graph', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Share graph', exact: true });
    await expect(dialog.getByLabel('Graph link')).toHaveValue(canonical.href);
    await expect(dialog).toContainText('Quick graphs can change');
    await expect(dialog).not.toContainText('completed expansion');
  });

  test('unmatched W selection uses the first S2 node; native canonical reload and Add origin never mix namespaces', async ({ page }) => {
    const configCalls = await mockConfig(page);
    const requests: string[][] = [];
    await page.route('**/api/graph?**', route => {
      const ids = new URL(route.request().url()).searchParams.get('ids')!.split(',');
      requests.push(ids);
      return route.fulfill({ json: ids[0].startsWith('W') ? fallbackGraph() : nativeGraph(ids) });
    });
    await page.goto(`/graph/${W[0]}/graph?selected=W9000099&keyword=Synthetic&from=2026`);
    await expect(page.locator(`g[data-paper-id="${S2[0]}"]`)).toHaveAttribute('aria-pressed', 'true');
    const canonicalLink = notice(page).getByRole('link', { name: 'Open canonical graph' });
    expect(new URL((await canonicalLink.getAttribute('href'))!).searchParams.get('selected')).toBe(S2[0]);
    await canonicalLink.click();
    await expect(notice(page)).toHaveCount(0);
    await expect(nodes(page)).toHaveCount(4);
    await expect(page).toHaveURL(url => url.pathname === `/graph/${S2[0]}/graph` && url.searchParams.get('selected') === S2[0]);
    await page.reload();
    await expect(nodes(page)).toHaveCount(4);
    const before = configCalls();
    await expect(details(page).locator('h2')).toHaveText(nativeGraph().nodes[0].title);
    await expect(page.locator('.graph-summary .data-badge')).toContainText('Semantic Scholar');
    const neighbor = nativeGraph().nodes[2];
    const button = page.locator('.sidebar-paper').filter({ has: page.locator('strong', { hasText: neighbor.title }) });
    await expect(button).toContainText('Direct citation');
    await button.click();
    await expect(details(page).getByRole('button', { name: 'Add origin', exact: true })).toBeEnabled();
    await details(page).getByRole('button', { name: 'Add origin', exact: true }).click();
    await expect(page).toHaveURL(url => url.pathname === `/graph/${S2[0]},${S2[2]}/graph` && url.searchParams.get('selected') === S2[2] && !url.searchParams.has('job') && url.searchParams.get('keyword') === 'Synthetic' && url.searchParams.get('from') === '2026');
    await expect(page.locator('.graph-origin-ring')).toHaveCount(2);
    await expect(details(page).locator('h2')).toHaveText(neighbor.title);
    expect(requests).toEqual([[W[0]], [S2[0]], [S2[0]], [S2[0], S2[2]]]);
    expect(configCalls()).toBe(before);

    await page.goto(`/graph/${W[0]}/graph?selected=${S2[2]}`);
    await expect(notice(page)).toBeVisible();
    await expect(details(page).locator('h2')).toHaveText(neighbor.title);
    await details(page).getByRole('button', { name: 'Add origin', exact: true }).click();
    await expect(page).toHaveURL(url => url.pathname === `/graph/${S2[0]},${S2[2]}/graph` && url.searchParams.get('selected') === S2[2]);
    await expect(page.locator('.graph-origin-ring')).toHaveCount(2);
    expect(requests.at(-1)).toEqual([S2[0], S2[2]]);
  });

  test('an already accepted completed OA result is cleared when the quick response resolves to S2', async ({ page }) => {
    await mockConfig(page);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/graph?**', async route => { await held; await route.fulfill({ json: fallbackGraph() }); });
    let gets = 0;
    await page.route(`**${jobPath}`, route => { gets++; return route.fulfill({ json: completedJob() }); });
    await page.goto(`/graph/${W[0]}/graph?job=${JOB_ID}&selected=${W[0]}`);
    await expect(details(page).locator('h2')).toHaveText(completedJob().result!.nodes[0].title);
    release();
    await expect(notice(page)).toContainText(noticeText);
    await expect(details(page).locator('h2')).toHaveText(nativeGraph().nodes[0].title);
    await expect(nodes(page)).toHaveCount(4);
    await expect(page.locator('.workspace-status')).toContainText('4 papers compared');
    await expect(page.getByRole('region', { name: 'Research expansion', exact: true })).toHaveCount(0);
    await views(page).getByRole('link', { name: /^List/ }).click();
    await views(page).getByRole('link', { name: 'Graph', exact: true }).click();
    await expect(nodes(page)).toHaveCount(4);
    await page.clock.install();
    await page.clock.fastForward(60000);
    expect(gets).toBe(1);
    await expect(page).toHaveURL(url => url.searchParams.get('job') === JOB_ID);
  });

  test('fallback aborts pending OA job updates and polling without cancelling the durable job', async ({ page }) => {
    await mockConfig(page);
    let releaseGraph!: () => void, releaseJob!: () => void;
    const heldGraph = new Promise<void>(resolve => { releaseGraph = resolve; });
    const heldJob = new Promise<void>(resolve => { releaseJob = resolve; });
    await page.route('**/api/graph?**', async route => { await heldGraph; await route.fulfill({ json: fallbackGraph() }); });
    const methods: string[] = [];
    await page.route(`**${jobPath}`, async route => {
      methods.push(route.request().method());
      if (methods.length === 1) return route.fulfill({ json: { ...completedJob(), state: 'running', phase: 'acquire', result: null } });
      await heldJob;
      await route.fulfill({ json: completedJob() }).catch(() => {});
    });
    await page.goto(`/graph/${W[0]}/graph?job=${JOB_ID}`);
    await expect(page.getByRole('region', { name: 'Research expansion', exact: true })).toContainText('Acquiring research candidates');
    await page.clock.install();
    await page.clock.fastForward(4000);
    await expect.poll(() => methods.length).toBe(2);
    releaseGraph();
    await expect(notice(page)).toBeVisible();
    releaseJob();
    await page.clock.fastForward(60000);
    await expect(nodes(page)).toHaveCount(4);
    await expect(details(page).locator('h2')).toHaveText(nativeGraph().nodes[0].title);
    await expect(page.getByRole('button', { name: 'Expand research', exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(url => url.searchParams.get('job') === JOB_ID);
    expect(methods).toEqual(['GET', 'GET']);
  });

  test('390px fallback notice, source badge and canonical link stay visible within bounds', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockConfig(page);
    await page.route('**/api/graph?**', route => route.fulfill({ json: fallbackGraph() }));
    await page.goto(`/graph/${W[0]}/graph?selected=${W[0]}`);
    await expect(notice(page)).toContainText(noticeText);
    await expect(notice(page)).toContainText('OpenAlex: 1 paper, 0 edges. Semantic Scholar: 4 papers, 3 edges.');
    await expect(page.locator('.graph-summary .data-badge')).toContainText('Semantic Scholar');
    await expect(page.locator('.graph-origin-ring')).toHaveCount(1);
    for (const element of [notice(page), notice(page).getByRole('status'), notice(page).getByRole('link'), page.locator('.graph-summary .data-badge')]) {
      await expect(element).toBeVisible();
      const rect = await element.boundingBox();
      expect(rect!.x).toBeGreaterThanOrEqual(0);
      expect(rect!.x + rect!.width).toBeLessThanOrEqual(390);
      expect(rect!.y).toBeGreaterThanOrEqual(0);
      expect(rect!.y + rect!.height).toBeLessThanOrEqual(844);
    }
    const widths = await page.evaluate(() => [document.documentElement.scrollWidth, document.body.scrollWidth]);
    expect(widths.every(width => width <= 390)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('synthetic-fallback-mobile.png'), fullPage: true });
    const unavailable = fallbackGraph();
    unavailable.meta.fallback!.reason = 'openalex_unavailable';
    unavailable.meta.fallback!.comparison.openalex = null;
    await page.route('**/api/graph?**', route => route.fulfill({ json: unavailable }));
    await page.reload();
    await expect(notice(page)).toContainText('Showing Semantic Scholar: OpenAlex was unavailable.');
    await expect(notice(page)).toContainText('OpenAlex: unavailable.');
    await expect(notice(page)).not.toContainText('limited connection data');
  });

  test('healthy real OA graph adds no browser-side S2 requests or fallback notice', async ({ page }) => {
    await page.route('**/api/graph-jobs/config', route => route.fulfill({ json: { ...config, available: false, persistence: 'none' } }));
    const apiCalls: string[] = [];
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) apiCalls.push(request.url()); });
    await page.goto('/graph/W2626778328/graph');
    await expect(nodes(page)).toHaveCount(40);
    await expect(notice(page)).toHaveCount(0);
    await expect(page.locator('.graph-summary .data-badge')).toContainText('OpenAlex');
    expect(apiCalls.filter(url => new URL(url).pathname === '/api/graph')).toHaveLength(1);
    expect(apiCalls.some(url => /semantic|S2%3A|S2:/.test(url))).toBe(false);
    // Exact upstream no-S2-call behavior is covered by server/graph-fallback.test.ts.
  });
});
