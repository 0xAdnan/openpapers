import { test, expect, type Page, type Route } from '@playwright/test';
import { GraphJobSchema, type GraphJob } from '../shared/graph-jobs';
import { GraphResponseSchema } from '../shared/schemas';
import type { GraphResponse } from '../shared/types';

const ORIGIN = 'W2626778328';
const OTHER = 'W2045435533';
const JOB_ID = '7a9488e2-7425-4b41-96bd-b941419ba3b0';
const jobPath = `/api/graph-jobs/${JOB_ID}`;
const config = { available: true, candidateBudget: 5000, maxCandidateBudget: 50000, requestBudget: 100, persistence: 'postgres' };
const banner = (page: Page) => page.getByRole('region', { name: 'Research expansion', exact: true });
const nodes = (page: Page) => page.locator('svg.graph-svg g[data-paper-id]');

function fixtureJob(patch: Partial<GraphJob> = {}): GraphJob {
  return GraphJobSchema.parse({
    id: JOB_ID, origins: [ORIGIN], state: 'queued', phase: 'acquire', candidateBudget: 5000,
    acquiredCount: 0, referenceCount: 0, referenceBudget: 2000000, requestsUsed: 0, requestBudget: 100,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    nextRunAt: null, stopReason: null, error: null, result: null, ...patch,
  });
}

function fixtureResult(quick: GraphResponse): GraphResponse {
  return GraphResponseSchema.parse({
    ...quick,
    nodes: quick.nodes.map(paper => ({ ...paper, title: `Integration fixture (not research metadata): ${paper.title}` })),
    prior: [], derivative: [],
    meta: { ...quick.meta, jobId: JOB_ID, candidateCount: 321, candidateBudget: 5000,
      referenceCount: 4567, algorithm: 'integration-fixture', warning: 'Synthetic integration fixture, not research metadata.',
      coverage: 'Synthetic completed-job projection for browser integration testing only.' },
  });
}

async function mockConfig(page: Page, patch: Partial<typeof config> = {}) {
  let calls = 0;
  await page.route('**/api/graph-jobs/config', route => { calls++; return route.fulfill({ json: { ...config, ...patch } }); });
  return () => calls;
}

async function quickGraph(page: Page, suffix = '') {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/graph');
  await page.goto(`/graph/${ORIGIN}/graph${suffix}`);
  const response = await pending;
  expect(response.ok(), await response.text()).toBe(true);
  const graph = GraphResponseSchema.parse(await response.json());
  await expect(nodes(page)).toHaveCount(40);
  return graph;
}

async function openExpansion(page: Page) {
  await page.getByRole('button', { name: 'Expand research', exact: true }).click();
  return page.getByRole('dialog', { name: 'Expand research', exact: true });
}

async function withinViewport(page: Page) {
  const sizes = await page.evaluate(() => ({ width: document.documentElement.clientWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(sizes.document).toBeLessThanOrEqual(sizes.width);
  expect(sizes.body).toBeLessThanOrEqual(sizes.width);
  const rect = await banner(page).boundingBox();
  expect(rect).not.toBeNull();
  expect(rect!.x).toBeGreaterThanOrEqual(0);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(sizes.width);
}

test.describe('Graph jobs UI integration fixtures (not research metadata)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.afterEach(async () => { await new Promise(resolve => setTimeout(resolve, 3000)); });

  test('unavailable jobs keep the real 40-paper quick graph without an expansion button or notice', async ({ page }) => {
    const calls = await mockConfig(page, { available: false, persistence: 'none' });
    let posts = 0;
    page.on('request', request => {
      const url = new URL(request.url());
      if (request.method() === 'POST' && url.pathname === '/api/graph-jobs') posts++;
    });
    await quickGraph(page);
    await expect.poll(calls).toBe(1);
    await expect(banner(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Expand research', exact: true })).toHaveCount(0);
    expect(posts).toBe(0);
    await expect(page.locator('.workspace-status')).toContainText('papers compared');
  });

  test('config loads once, opening or dismissing the dialog is free, and explicit double submit creates once', async ({ page }) => {
    const calls = await mockConfig(page);
    let posts = 0;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/graph-jobs', async route => {
      expect(route.request().method()).toBe('POST');
      posts++;
      expect(route.request().postDataJSON()).toEqual({ origins: [ORIGIN], candidateBudget: 5000 });
      await held;
      await route.fulfill({ status: 202, json: fixtureJob() });
    });
    await page.route(`**${jobPath}`, route => route.fulfill({ json: fixtureJob() }));
    await quickGraph(page);
    expect(posts).toBe(0);
    let dialog = await openExpansion(page);
    await expect(dialog.getByLabel('Candidate target')).toHaveValue('5000');
    await expect(dialog.locator('option')).toHaveText(['1,000 candidates', '5,000 candidates']);
    await expect(dialog).toContainText('Current server limit: 5,000 candidates');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Expand research', exact: true })).toBeFocused();
    expect(posts).toBe(0);
    dialog = await openExpansion(page);
    await dialog.locator('form').evaluate(form => { (form as HTMLFormElement).requestSubmit(); (form as HTMLFormElement).requestSubmit(); });
    await expect.poll(() => posts).toBe(1);
    await expect(dialog.getByRole('button', { name: 'Starting...', exact: true })).toBeDisabled();
    release();
    await expect(page).toHaveURL(url => url.searchParams.get('job') === JOB_ID);
    await expect(banner(page)).toContainText('0 / 5,000 candidates acquired');
    await page.getByRole('navigation', { name: 'Graph views' }).getByRole('link', { name: /^List/ }).click();
    await expect(banner(page)).toBeVisible();
    expect(calls()).toBe(1);
    expect(posts).toBe(1);
  });

  test('polls acquired counts, preserves selection and camera, backs off paused jobs up to 30 seconds, and reload resumes to completion', async ({ page }) => {
    await mockConfig(page);
    let job = fixtureJob();
    let gets = 0, posts = 0;
    await page.route('**/api/graph-jobs', route => { posts++; return route.fulfill({ status: 202, json: job }); });
    await page.route(`**${jobPath}`, route => { gets++; return route.fulfill({ json: job }); });
    const quick = await quickGraph(page);
    const selected = quick.nodes.find(paper => !paper.isOrigin)!;
    await page.locator('.sidebar-paper').filter({ has: page.locator('strong', { hasText: selected.title }) }).click();
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    const camera = await page.locator('svg.graph-svg > g').getAttribute('transform');
    const positions = await nodes(page).evaluateAll(elements => elements.map(element => element.getAttribute('transform')));
    await page.clock.install();
    const dialog = await openExpansion(page);
    await dialog.getByRole('button', { name: 'Start expansion', exact: true }).click();
    await expect(banner(page)).toContainText('queued');
    job = fixtureJob({ state: 'running', acquiredCount: 123, requestsUsed: 8, referenceCount: 4567 });
    await page.clock.fastForward(4000);
    await expect(banner(page)).toContainText('123 / 5,000 candidates acquired');
    await expect(banner(page)).toContainText('8 / 100 request attempts reserved');
    await expect(banner(page)).toContainText('4,567 / 2,000,000 reference entries');
    await expect.poll(() => nodes(page).evaluateAll(elements => elements.map(element => element.getAttribute('transform')))).toEqual(positions);
    expect((await page.locator('svg.graph-svg > g').getAttribute('transform'))!.split('scale(')[1]).toBe(camera!.split('scale(')[1]);
    await expect(page).toHaveURL(url => url.searchParams.get('selected') === selected.id && url.searchParams.get('job') === JOB_ID);
    const nextRunAt = await page.evaluate(() => new Date(Date.now() + 120000).toISOString());
    job = fixtureJob({ state: 'paused', acquiredCount: 123, nextRunAt, error: 'Integration fixture: provider temporarily rate limited.' });
    await page.clock.fastForward(4000);
    await expect(banner(page)).toContainText('Research expansion paused');
    await expect(banner(page).locator('time')).toHaveAttribute('dateTime', nextRunAt);
    const before = gets;
    await page.clock.fastForward(29000);
    expect(gets).toBe(before);
    await page.clock.fastForward(1000);
    await expect.poll(() => gets).toBe(before + 1);
    job = fixtureJob({ state: 'completed', phase: 'publish', acquiredCount: 321, requestsUsed: 100, referenceCount: 4567,
      stopReason: 'request_budget', result: fixtureResult(quick) });
    const reloadGet = page.waitForResponse(response => new URL(response.url()).pathname === jobPath);
    await page.reload();
    await reloadGet;
    await expect(banner(page)).toContainText('Research expansion complete');
    await expect(banner(page)).toContainText('321 / 5,000 candidates acquired');
    await expect(banner(page)).toContainText('request attempt limit reached');
    await expect(banner(page)).not.toContainText('5,000 analyzed');
    await expect(page.locator('.detail-sidebar h2')).toHaveText(`Integration fixture (not research metadata): ${selected.title}`);
    await expect(nodes(page)).toHaveCount(40);
    await expect(page.locator('.workspace-status')).toContainText('321 papers compared');
    const completedGets = gets;
    await page.clock.fastForward(60000);
    expect(gets).toBe(completedGets);
    expect(posts).toBe(1);
    await withinViewport(page);
  });

  test('hiding updates and leaving the page stop polling, never cancel the durable job', async ({ page }) => {
    await mockConfig(page);
    let gets = 0;
    const methods: string[] = [];
    await page.route(`**${jobPath}`, route => { gets++; methods.push(route.request().method()); return route.fulfill({ json: fixtureJob({ state: 'running' }) }); });
    await quickGraph(page, `?job=${JOB_ID}`);
    await expect(banner(page)).toContainText('Acquiring research candidates');
    await page.clock.install();
    await banner(page).getByRole('button', { name: 'Hide updates', exact: true }).click();
    await expect(banner(page)).toContainText('durable job continues on the server');
    const hiddenGets = gets;
    await page.clock.fastForward(60000);
    expect(gets).toBe(hiddenGets);
    await expect(page).toHaveURL(url => url.searchParams.get('job') === JOB_ID);
    await banner(page).getByRole('button', { name: 'Resume updates', exact: true }).click();
    await expect.poll(() => gets).toBeGreaterThan(hiddenGets);
    await page.getByRole('link', { name: 'Open Papers home', exact: true }).click();
    await expect(page).toHaveURL(/\/(?:#main)?$/);
    const awayGets = gets;
    await page.clock.fastForward(60000);
    expect(gets).toBe(awayGets);
    expect(methods.every(method => method === 'GET')).toBe(true);
  });

  test('matches origin sets independent of order and clears the job on re-origin', async ({ page }) => {
    await mockConfig(page);
    await page.route(`**${jobPath}`, route => route.fulfill({ json: fixtureJob({ origins: [ORIGIN, OTHER], state: 'running', acquiredCount: 2 }) }));
    await page.goto(`/graph/${OTHER},${ORIGIN}/graph?job=${JOB_ID}`);
    await expect(nodes(page)).toHaveCount(40);
    await expect(banner(page)).toContainText('2 / 5,000 candidates acquired');
    await expect(page).toHaveURL(url => url.searchParams.get('job') === JOB_ID);
    const otherPaper = page.locator('.sidebar-paper').filter({ hasNot: page.locator('.origin-label') }).first();
    await otherPaper.click();
    await page.locator('.detail-sidebar').getByRole('link', { name: 'Open graph', exact: true }).click();
    await expect(page).toHaveURL(url => !url.searchParams.has('job'));
    await expect(nodes(page)).toHaveCount(40);
    await expect(banner(page)).toContainText('Quick graph coverage');
  });

  test('rejects another origin job and removes its URL ID without applying its result', async ({ page }) => {
    await mockConfig(page);
    await page.route(`**${jobPath}`, route => route.fulfill({ json: fixtureJob({ origins: [OTHER] }) }));
    await quickGraph(page, `?job=${JOB_ID}`);
    await expect(banner(page)).toContainText('different origin papers');
    await expect(page).toHaveURL(url => !url.searchParams.has('job'));
    await expect(nodes(page)).toHaveCount(40);
  });

  for (const width of [390, 834]) {
    test(`completed fixture, budget dialog and running banner fit ${width}px graph/list/prior panels`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await mockConfig(page, { candidateBudget: 50000 });
      const quick = await quickGraph(page);
      await page.route('**/api/graph-jobs', route => route.fulfill({ status: 200, json: fixtureJob({ state: 'completed', phase: 'publish', result: fixtureResult(quick), acquiredCount: 321 }) }));
      const dialog = await openExpansion(page);
      await expect(dialog.locator('option')).toHaveText(['1,000 candidates', '5,000 candidates', '10,000 candidates', '50,000 candidates']);
      await expect(dialog.getByLabel('Candidate target')).toHaveValue('5000');
      await dialog.getByLabel('Candidate target').selectOption('10000');
      await withinViewport(page);
      await dialog.getByRole('button', { name: 'Start expansion', exact: true }).click();
      await expect(banner(page)).toContainText('complete');
      await expect(nodes(page)).toHaveCount(40);
      await withinViewport(page);
      for (const label of [/^List/, /^Prior/]) {
        await page.getByRole('navigation', { name: 'Graph views' }).getByRole('link', { name: label }).click();
        await expect(banner(page)).toBeVisible();
        await withinViewport(page);
      }
      await page.route(`**${jobPath}`, route => route.fulfill({ json: fixtureJob({ state: 'running', acquiredCount: 123, requestsUsed: 8, referenceCount: 4567 }) }));
      await page.reload();
      await expect(banner(page)).toContainText('Acquiring research candidates');
      await withinViewport(page);
      await page.screenshot({ path: testInfo.outputPath(`jobs-${width}.png`), fullPage: true });
    });
  }

  test('completed results fall back to their first node when the selected paper is absent', async ({ page }) => {
    await mockConfig(page);
    const quick = await quickGraph(page);
    const removed = quick.nodes.find(paper => !paper.isOrigin)!;
    const result = fixtureResult(quick);
    result.nodes = result.nodes.filter(paper => paper.id !== removed.id);
    result.edges = result.edges.filter(edge => edge.source !== removed.id && edge.target !== removed.id);
    await page.route(`**${jobPath}`, route => route.fulfill({ json: fixtureJob({ state: 'completed', result }) }));
    await page.goto(`/graph/${ORIGIN}/graph?job=${JOB_ID}&selected=${removed.id}`);
    await expect(banner(page)).toContainText('complete');
    await expect(nodes(page)).toHaveCount(39);
    await expect(page.locator('.detail-sidebar h2')).toHaveText(result.nodes[0].title);
  });

  for (const failure of ['404', 'html', 'invalid', 'oversized', 'network'] as const) {
    test(`${failure} job response fails safely while the real quick graph remains usable`, async ({ page }) => {
      await mockConfig(page);
      let gets = 0;
      await page.route(`**${jobPath}`, (route: Route) => {
        gets++;
        if (failure === '404') return route.fulfill({ status: 404, json: { error: 'Integration fixture: graph job not found' } });
        if (failure === 'html') return route.fulfill({ status: 502, contentType: 'text/html', body: '<h1>Platform gateway failure</h1>' });
        if (failure === 'oversized') return route.fulfill({ contentType: 'application/json', body: ' '.repeat(4 * 1024 * 1024 + 1) });
        if (failure === 'network') return route.abort('failed');
        return route.fulfill({ json: { ...fixtureJob(), acquiredCount: 50001 } });
      });
      const runtimeErrors: string[] = [];
      page.on('pageerror', error => runtimeErrors.push(error.message));
      await quickGraph(page, `?job=${JOB_ID}`);
      await expect(banner(page)).toContainText(failure === '404' ? 'HTTP 404' : failure === 'html' ? 'non-JSON response (HTTP 502)' : failure === 'oversized' ? '4 MiB limit' : failure === 'network' ? 'Could not reach' : 'invalid graph job data');
      await page.clock.install();
      const count = gets;
      await page.clock.fastForward(4000);
      if (failure === 'html' || failure === 'network') await expect.poll(() => gets).toBeGreaterThan(count);
      else expect(gets).toBe(count);
      await expect(nodes(page)).toHaveCount(40);
      await banner(page).getByRole('button', { name: 'Remove job from view', exact: true }).click();
      await expect(page).toHaveURL(url => !url.searchParams.has('job'));
      await expect(banner(page)).not.toContainText('HTTP');
      expect(runtimeErrors).toEqual([]);
    });
  }

  test('late job responses cannot overwrite a new graph route', async ({ page }) => {
    await mockConfig(page);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**${jobPath}`, async route => { await held; await route.fulfill({ json: fixtureJob({ acquiredCount: 4999 }) }).catch(() => {}); });
    await quickGraph(page, `?job=${JOB_ID}`);
    const candidate = page.locator('.sidebar-paper').filter({ hasNot: page.locator('.origin-label') }).first();
    await candidate.click();
    await page.locator('.detail-sidebar').getByRole('link', { name: 'Open graph', exact: true }).click();
    await expect(page).toHaveURL(url => !url.searchParams.has('job'));
    release();
    await expect(nodes(page)).toHaveCount(40);
    await expect(banner(page)).toContainText('Quick graph coverage');
    await expect(banner(page)).not.toContainText('4,999');
  });

  test('POST failures are inline and do not retry automatically or replace the quick graph', async ({ page }) => {
    await mockConfig(page);
    let posts = 0;
    await page.route('**/api/graph-jobs', route => { posts++; return route.fulfill({ status: 503, contentType: 'text/html', body: '<h1>Integration fixture gateway unavailable</h1>' }); });
    await quickGraph(page);
    const dialog = await openExpansion(page);
    await dialog.getByRole('button', { name: 'Start expansion', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('non-JSON response (HTTP 503)');
    await expect(dialog.getByRole('button', { name: 'Start expansion', exact: true })).toBeEnabled();
    await page.clock.install();
    await page.clock.fastForward(60000);
    expect(posts).toBe(1);
    await page.keyboard.press('Escape');
    await expect(nodes(page)).toHaveCount(40);
    await expect(page).toHaveURL(url => !url.searchParams.has('job'));
  });

  test('invalid job IDs make no job request and failed jobs stop polling', async ({ page }) => {
    await mockConfig(page);
    let gets = 0;
    await page.route(`**${jobPath}`, route => { gets++; return route.fulfill({ json: fixtureJob({ state: 'failed', stopReason: 'provider_rejected', error: 'Integration fixture: OpenAlex rejected acquisition.' }) }); });
    await quickGraph(page, '?job=not-a-uuid');
    await expect(banner(page)).toContainText('Invalid research job link');
    expect(gets).toBe(0);
    await page.goto(`/graph/${ORIGIN}/graph?job=${JOB_ID}`);
    await expect(banner(page)).toContainText('Research expansion failed');
    await expect(banner(page)).toContainText('data provider rejected the request');
    await page.clock.install();
    await page.clock.fastForward(60000);
    expect(gets).toBe(1);
    await expect(nodes(page)).toHaveCount(40);
    await expect(page.getByRole('button', { name: /cancel/i })).toHaveCount(0);
  });
});
