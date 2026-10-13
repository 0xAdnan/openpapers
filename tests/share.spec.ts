import type { Page } from '@playwright/test';
import type { GraphResponse } from '../shared/types';
import { GraphResponseSchema } from '../shared/schemas';
import { paperMatchScore } from '../shared/fuzzy';
import { test as base, expect, EXAMPLES, nodes, details, graphPapers, views, openGraph,
  focusStaysInDialog, noHorizontalOverflow, screenshot } from './fixtures';

declare global {
  interface Window {
    capturedGraphLink?: string;
    graphShareCalls?: ShareData[];
  }
}

const test = base.extend<{
  clipboardMode: 'success' | 'reject';
  nativeShareMode: 'unavailable' | 'success' | 'abort' | 'error';
  shareBrowser: void;
}>({
  clipboardMode: ['success', { option: true }],
  nativeShareMode: ['unavailable', { option: true }],
  shareBrowser: [async ({ page, clipboardMode, nativeShareMode }, use) => {
    // Browser capability fixtures only. All graph/provider responses stay real.
    await page.addInitScript(({ clipboardMode, nativeShareMode }) => {
      window.graphShareCalls = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text: string) => {
          if (clipboardMode === 'reject') throw new DOMException('Clipboard denied', 'NotAllowedError');
          window.capturedGraphLink = text;
        } },
      });
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: nativeShareMode === 'unavailable' ? undefined : async (data: ShareData) => {
          window.graphShareCalls?.push(data);
          if (nativeShareMode === 'abort') throw new DOMException('Share cancelled', 'AbortError');
          if (nativeShareMode === 'error') throw new Error('Share unavailable');
        },
      });
    }, { clipboardMode, nativeShareMode });
    await use();
  }, { auto: true }],
});

// This focused suite stays below the real 60-request/minute API limit.
test.afterEach(async () => { await new Promise(resolve => setTimeout(resolve, 2000)); });

async function loadGraph(page: Page, url: string): Promise<GraphResponse> {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/graph');
  await page.goto(url);
  const response = await pending;
  expect(response.ok(), `${response.status()} ${response.url()}: ${await response.text()}`).toBe(true);
  const graph = GraphResponseSchema.parse(await response.json());
  await expect(page.getByRole('button', { name: 'Share graph', exact: true })).toBeEnabled();
  return graph;
}

test('desktop single-origin copy opens the real graph in a fresh context without the saved library', async ({ page, browser }, testInfo) => {
  const graph = await openGraph(page);
  const selected = graph.nodes.find(paper => !paper.isOrigin)!;
  await graphPapers(page).getByRole('button').filter({ has: page.locator('strong', { hasText: selected.title }) }).click();
  await expect(page).toHaveURL(url => url.searchParams.get('selected') === selected.id);
  await page.mouse.move(0, 0);
  await details(page).getByRole('button', { name: `Save ${selected.title}`, exact: true }).click();
  await expect(details(page).getByRole('button', { name: `Unsave ${selected.title}`, exact: true })).toHaveAttribute('aria-pressed', 'true');

  const opener = page.getByRole('button', { name: 'Share graph', exact: true });
  await expect(opener).toBeVisible();
  await expect(opener.locator('span')).toHaveText('Share');
  const originalUrl = page.url();
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Share graph', exact: true });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => element instanceof HTMLDialogElement && element.matches(':modal'))).toBe(true);
  await expect(dialog.getByLabel('Graph link')).toHaveJSProperty('readOnly', true);
  await expect(dialog.getByLabel('Graph link')).toHaveValue(originalUrl);
  await expect(dialog).toContainText('not your private saved library');
  await expect(dialog).toContainText('Quick graphs can change');
  await expect(dialog.getByRole('button', { name: 'Share via...', exact: true })).toHaveCount(0);
  await focusStaysInDialog(page, dialog);
  await dialog.getByRole('button', { name: 'Copy link', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
  await expect(dialog.getByRole('status')).toHaveText('Graph link copied.');
  const copied = await page.evaluate(() => window.capturedGraphLink);
  expect(copied).toBe(originalUrl);
  expect(new URL(copied!).origin).toBe(new URL(page.url()).origin);
  await noHorizontalOverflow(page, testInfo, 'desktop-share');
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await screenshot(page, testInfo, 'desktop-share-copied');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
  await expect(page).toHaveURL(originalUrl);
  await page.keyboard.press('Enter');
  await expect(dialog.getByLabel('Graph link')).toHaveValue(copied!);
  await expect(dialog.getByRole('button', { name: 'Copy link', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(opener).toBeFocused();

  const recipient = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const fresh = await recipient.newPage();
    const reopened = await loadGraph(fresh, copied!);
    expect(reopened.origins).toEqual(graph.origins);
    expect(reopened.nodes).toEqual(graph.nodes);
    expect(reopened.edges).toEqual(graph.edges);
    await expect(nodes(fresh)).toHaveCount(reopened.nodes.length);
    await expect(fresh.locator(`g[data-paper-id="${selected.id}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(views(fresh).getByRole('link', { name: 'Graph', exact: true })).toHaveClass('active');
    await expect(fresh).toHaveURL(copied!);
    expect(await fresh.evaluate(() => localStorage.getItem('open-papers-library'))).toBeNull();
    await fresh.mouse.move(0, 0);
    await expect(details(fresh).getByRole('button', { name: `Save ${selected.title}`, exact: true })).toHaveAttribute('aria-pressed', 'false');
    await screenshot(fresh, testInfo, 'desktop-shared-graph-fresh-context');
    await fresh.goto('/library');
    await expect(fresh.getByRole('heading', { name: 'A home for your next discovery', exact: true })).toBeVisible();
    await expect(fresh.locator('.library-row')).toHaveCount(0);
  } finally { await recipient.close(); }
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('open-papers-library') ?? '[]').map((paper: { id: string }) => paper.id))).toEqual([selected.id]);
});

test.describe('clipboard denial', () => {
  test.use({ clipboardMode: 'reject' });

  test('copy failure focuses and selects the entire link for manual copying', async ({ page }, testInfo) => {
    await openGraph(page);
    await page.getByRole('button', { name: 'Share graph', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Share graph', exact: true });
    const input = dialog.getByLabel('Graph link');
    const link = await input.inputValue();
    await dialog.getByRole('button', { name: 'Copy link', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText('Clipboard access is unavailable. The link is selected so you can copy it manually.');
    await expect(input).toBeFocused();
    const selection = await input.evaluate(element => {
      const input = element as HTMLInputElement;
      return { start: input.selectionStart, end: input.selectionEnd, value: input.value };
    });
    expect(selection).toEqual({ start: 0, end: link.length, value: link });
    expect(await page.evaluate(() => window.capturedGraphLink)).toBeUndefined();
    await expect(dialog.getByRole('button', { name: 'Copied', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Copy link', exact: true })).toBeEnabled();
    await screenshot(page, testInfo, 'desktop-share-manual-copy');
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Share graph', exact: true })).toBeFocused();
  });
});

test('two real origins share list view, selection and all filters while dropping credentials and telemetry', async ({ page, browser }, testInfo) => {
  const ids = EXAMPLES.slice(0, 2).map(example => example.id);
  const unwanted = new URLSearchParams({
    token: 'private-test-token', access_token: 'private-access-token', api_key: 'private-api-key',
    utm_source: 'share_popup', utm_medium: 'social', utm_campaign: 'test',
    gclid: 'test-click', fbclid: 'test-social-click', telemetry: 'test-event', tracking_id: 'test-tracking',
    provider: 'openalex', unrelated: 'test-value',
  });
  const graph = await loadGraph(page, `/graph/${ids.join(',')}/graph?${unwanted}`);
  expect(graph.origins).toEqual(ids);
  await expect(nodes(page)).toHaveCount(graph.nodes.length);
  await expect(page.locator('g.graph-node--origin')).toHaveCount(2);
  const selected = graph.nodes.find(paper => !paper.isOrigin && paper.openAccess && paper.pdfUrl && paper.year)!;
  expect(selected, 'Real bundled graph needs an OA/PDF/year candidate for composed filters').toBeTruthy();
  const keyword = selected.title.split(/\s+/).find(word => /^[a-z]{4,}$/i.test(word))!;
  expect(keyword).toBeTruthy();
  await graphPapers(page).getByRole('button').filter({ has: page.locator('strong', { hasText: selected.title }) }).click();
  await expect(page).toHaveURL(url => url.searchParams.get('selected') === selected.id);
  await page.getByRole('button', { name: 'Filter papers', exact: true }).click();
  const filters = page.getByRole('dialog', { name: 'Filter graph papers', exact: true });
  await filters.getByLabel('Title or author').fill(keyword);
  await filters.getByLabel('From year').fill(String(selected.year));
  await filters.getByLabel('To year').fill(String(selected.year));
  await filters.getByRole('checkbox', { name: 'Open access only' }).check();
  await filters.getByRole('checkbox', { name: 'PDF available' }).check();
  await filters.getByRole('button', { name: 'Apply filters' }).click();
  const visible = graph.nodes.filter(paper => paper.isOrigin || (paper.openAccess && Boolean(paper.pdfUrl) && paper.year === selected.year &&
    (paperMatchScore(keyword, paper) > 0 || `${paper.title} ${paper.authors.slice(0, 3).join(', ')}`.toLowerCase().includes(keyword.toLowerCase()))));
  expect(visible.length).toBeLessThan(graph.nodes.length);
  expect(visible.map(paper => paper.id)).toContain(selected.id);
  await expect(nodes(page)).toHaveCount(visible.length);
  await views(page).getByRole('link', { name: 'List view', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(visible.length);
  await page.getByRole('button', { name: 'Share graph', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Share graph', exact: true });
  await dialog.getByRole('button', { name: 'Copy link', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('Graph link copied.');
  const copied = await page.evaluate(() => window.capturedGraphLink);
  expect(copied).toBe(await dialog.getByLabel('Graph link').inputValue());
  const url = new URL(copied!);
  expect(url.origin).toBe(new URL(page.url()).origin);
  expect(url.pathname).toBe(`/graph/${ids.join(',')}/list`);
  const expectedParams = { selected: selected.id, keyword, from: String(selected.year), to: String(selected.year), oa: '1', pdf: '1' };
  expect(Object.fromEntries(url.searchParams)).toEqual(expectedParams);
  for (const key of unwanted.keys()) expect(url.searchParams.has(key), `Dropped ${key}`).toBe(false);
  await screenshot(page, testInfo, 'desktop-multi-origin-share');

  const recipient = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const fresh = await recipient.newPage();
    const reopened = await loadGraph(fresh, copied!);
    expect(reopened.origins).toEqual(ids);
    expect(reopened.nodes).toEqual(graph.nodes);
    expect(reopened.edges).toEqual(graph.edges);
    await expect(fresh).toHaveURL(copied!);
    await expect(views(fresh).getByRole('link', { name: 'List view', exact: true })).toHaveClass('active');
    await expect(fresh.getByRole('heading', { name: 'All graph papers', exact: true })).toBeVisible();
    await expect(fresh.locator('tbody tr')).toHaveCount(visible.length);
    expect((await fresh.locator('.table-title').allTextContents()).sort()).toEqual(visible.map(paper => paper.title).sort());
    await expect(fresh.locator('tbody tr.selected .table-title')).toHaveText(selected.title);
    await expect(fresh.locator('tbody .origin-dot')).toHaveCount(2);
    for (const origin of graph.nodes.filter(paper => paper.isOrigin)) {
      await expect(fresh.getByRole('button', { name: origin.title, exact: true })).toBeVisible();
    }
    expect(await fresh.evaluate(() => localStorage.getItem('open-papers-library'))).toBeNull();
    await fresh.getByRole('button', { name: 'Filter papers', exact: true }).click();
    const restored = fresh.getByRole('dialog', { name: 'Filter graph papers', exact: true });
    await expect(restored.getByLabel('Title or author')).toHaveValue(keyword);
    await expect(restored.getByLabel('From year')).toHaveValue(String(selected.year));
    await expect(restored.getByLabel('To year')).toHaveValue(String(selected.year));
    await expect(restored.getByRole('checkbox', { name: 'Open access only' })).toBeChecked();
    await expect(restored.getByRole('checkbox', { name: 'PDF available' })).toBeChecked();
    await fresh.keyboard.press('Escape');
    await screenshot(fresh, testInfo, 'desktop-shared-filtered-list-fresh-context');
    await testInfo.attach('actual-shared-graph-response', { body: JSON.stringify(reopened), contentType: 'application/json' });
  } finally { await recipient.close(); }
});

for (const outcome of ['success', 'abort', 'error'] as const) {
  test.describe(`mobile native share ${outcome}`, () => {
    test.use({ nativeShareMode: outcome, viewport: { width: 390, height: 844 } });

    test(`native ${outcome} uses the graph link safely and leaves copy available without dialog overflow`, async ({ page }, testInfo) => {
      const graph = await openGraph(page);
      const opener = page.getByRole('button', { name: 'Share graph', exact: true });
      await expect(opener).toBeVisible();
      await expect(opener.locator('span')).toHaveText('Share');
      await opener.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Share graph', exact: true });
      await expect(dialog).toBeVisible();
      await focusStaysInDialog(page, dialog);
      const link = await dialog.getByLabel('Graph link').inputValue();
      const nativeButton = dialog.getByRole('button', { name: 'Share via...', exact: true });
      await nativeButton.click();
      await expect.poll(() => page.evaluate(() => window.graphShareCalls)).toEqual([{
        title: `Open Papers: ${graph.nodes.filter(paper => paper.isOrigin).map(paper => paper.title).join(' + ')}`,
        text: 'Explore this research graph on Open Papers.', url: link,
      }]);
      await expect(nativeButton).toBeEnabled();
      await expect(dialog.getByRole('status')).toHaveText(outcome === 'success' ? 'Share sheet closed.' :
        outcome === 'error' ? 'Sharing is unavailable. Use Copy link instead.' : '');
      await expect(dialog).toBeVisible();
      await expect(page).toHaveURL(link);
      await noHorizontalOverflow(page, testInfo, `mobile-share-${outcome}`);
      const layout = await dialog.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
          width: innerWidth, height: innerHeight, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
      });
      expect(layout.left).toBeGreaterThanOrEqual(0);
      expect(layout.right).toBeLessThanOrEqual(layout.width);
      expect(layout.top).toBeGreaterThanOrEqual(0);
      expect(layout.bottom).toBeLessThanOrEqual(layout.height);
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
      await screenshot(page, testInfo, `mobile-native-share-${outcome}`);
      await dialog.getByRole('button', { name: 'Copy link', exact: true }).click();
      await expect(dialog.getByRole('status')).toHaveText('Graph link copied.');
      await expect(dialog.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
      expect(await page.evaluate(() => window.capturedGraphLink)).toBe(link);
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await expect(opener).toBeFocused();
    });
  });
}
