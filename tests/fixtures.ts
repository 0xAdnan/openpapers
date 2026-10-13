import { test as base, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { GraphResponse, Paper } from '../shared/types';

declare global { interface Window { cspViolations?: string[] } }

export const EXAMPLES = [
  { id: 'W2626778328', title: 'Attention Is All You Need' },
  { id: 'W2045435533', title: 'A Programmable Dual-RNA\u2013Guided DNA Endonuclease in Adaptive Bacterial Immunity' },
  { id: 'W2252795400', title: 'Observation of Gravitational Waves from a Binary Black Hole Merger' },
];

// Synthetic local-storage records only, not scholarly metadata or a provider cache.
export const S2_SAVED_PAPERS: Paper[] = ['1', '2'].map(suffix => ({
  id: `S2:${'0'.repeat(39)}${suffix}`,
  title: `UI fixture: saved Semantic Scholar record ${suffix} (not a real publication)`,
  authors: ['UI fixture author'], year: null, venue: 'Synthetic UI fixture', citations: 0,
  references: [], abstract: 'Synthetic metadata for local-library UI testing. Not a real scholarly claim.',
  doi: null, url: `https://www.semanticscholar.org/paper/${'0'.repeat(39)}${suffix}`,
  pdfUrl: null, openAccess: false, topics: [],
}));

type Diagnostics = { expectedFailureUrls: Set<string>; searchRequests: string[] };

export const test = base.extend<{ diagnostics: Diagnostics }>({
  viewport: { width: 1440, height: 900 },
  diagnostics: [async ({ page }, use, testInfo) => {
    const expectedFailureUrls = new Set<string>();
    const searchRequests: string[] = [];
    const runtimeErrors: string[] = [];
    const consoleErrors: { text: string; url: string }[] = [];
    const httpErrors: { status: number; url: string }[] = [];
    const networkErrors: string[] = [];
    await page.addInitScript(() => {
      window.cspViolations = [];
      document.addEventListener('securitypolicyviolation', event => {
        window.cspViolations?.push(`${event.violatedDirective}: ${event.blockedURI}`);
      });
    });
    page.on('pageerror', error => runtimeErrors.push(error.stack ?? error.message));
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname === '/api/search') searchRequests.push(url.pathname + url.search);
    });
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push({ text: message.text(), url: message.location().url });
    });
    page.on('response', response => {
      if (response.status() >= 400) httpErrors.push({ status: response.status(), url: response.url() });
    });
    page.on('requestfailed', request => {
      // React cancels in-flight autocomplete requests when focus or routes change.
      if (request.failure()?.errorText !== 'net::ERR_ABORTED') {
        networkErrors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`);
      }
    });
    await use({ expectedFailureUrls, searchRequests });
    const cspViolations = await page.evaluate(() => window.cspViolations ?? []);
    expect.soft(cspViolations, 'Production CSP violations').toEqual([]);
    const expected = (url: string) => expectedFailureUrls.has(new URL(url).pathname + new URL(url).search);
    const unexpectedConsole = consoleErrors.filter(error => !(error.url && expected(error.url) &&
      /^Failed to load resource: the server responded with a status of (400|404|503)\b/.test(error.text)));
    const unexpectedHttp = httpErrors.filter(error => !expected(error.url));
    expect.soft(searchRequests.filter(url => new URL(url, page.url()).searchParams.get('provider') !== 'openalex' && !expectedFailureUrls.has(url)),
      'All ordinary searches must use the configured OpenAlex source').toEqual([]);
    await testInfo.attach('browser-diagnostics', {
      body: JSON.stringify({ runtimeErrors, consoleErrors, httpErrors, networkErrors, searchRequests }, null, 2),
      contentType: 'application/json',
    });
    expect.soft(runtimeErrors, 'Uncaught browser runtime errors').toEqual([]);
    expect.soft(unexpectedConsole.map(error => ({ ...error,
      text: error.text.replace(/data:font\/[^']+/g, 'data:font/[base64 omitted; full message in browser-diagnostics]'),
    })), 'Unexpected console errors').toEqual([]);
    expect.soft(unexpectedHttp, 'Unexpected failed HTTP responses').toEqual([]);
    expect.soft(networkErrors, 'Unexpected failed network requests').toEqual([]);
  }, { auto: true }],
});

export { expect };

export const nodes = (page: Page) => page.locator('svg.graph-svg g[data-paper-id]');
export const details = (page: Page) => page.getByRole('complementary', { name: 'Selected paper details' });
export const graphPapers = (page: Page) => page.getByRole('complementary', { name: 'Graph papers' });
export const views = (page: Page) => page.getByRole('navigation', { name: 'Graph views' });

export async function openGraph(page: Page, id = EXAMPLES[0].id): Promise<GraphResponse> {
  const responsePromise = page.waitForResponse(response => response.url().includes('/api/graph?'));
  await page.goto(`/graph/${id}/graph`);
  const response = await responsePromise;
  expect(response.ok(), await response.text()).toBeTruthy();
  const graph: GraphResponse = await response.json();
  await expect(nodes(page)).toHaveCount(graph.nodes.length);
  await expect(page.getByRole('region', { name: 'Paper similarity graph', exact: true })).toBeVisible();
  return graph;
}

export async function selectPaper(page: Page, paper: { id: string; title: string }) {
  await graphPapers(page).getByRole('button').filter({ has: page.locator('strong', { hasText: paper.title }) }).click();
  await expect(page).toHaveURL(url => url.searchParams.get('selected') === paper.id);
  await expect(details(page).getByRole('heading', { name: paper.title, exact: true })).toBeVisible();
}

export async function noHorizontalOverflow(page: Page, testInfo: TestInfo, label: string) {
  const metrics = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    return {
      url: location.href, viewport: innerWidth, width,
      documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth,
      outsideViewport: [...document.querySelectorAll<HTMLElement>('body *')].flatMap(element => {
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height || (rect.left >= 0 && rect.right <= width)) return [];
        return [{ tag: element.tagName, class: element.getAttribute('class'), left: rect.left, right: rect.right }];
      }).slice(0, 20),
    };
  });
  await testInfo.attach(`layout-${label}`, { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' });
  expect.soft(metrics.documentWidth, `${label}: document horizontal overflow at ${metrics.url}`).toBeLessThanOrEqual(metrics.width);
  expect.soft(metrics.bodyWidth, `${label}: body horizontal overflow at ${metrics.url}`).toBeLessThanOrEqual(metrics.width);
}

export async function screenshot(page: Page, testInfo: TestInfo, label: string) {
  const path = testInfo.outputPath(`${label}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(label, { path, contentType: 'image/png' });
}

export async function download(page: Page, button: Locator, filename: string, testInfo: TestInfo) {
  const pending = page.waitForEvent('download');
  await button.click();
  const file = await pending;
  expect(file.suggestedFilename()).toBe(filename);
  expect(await file.failure()).toBeNull();
  const path = testInfo.outputPath(filename);
  await file.saveAs(path);
  const content = await readFile(path, 'utf8');
  expect(content.length).toBeGreaterThan(0);
  await testInfo.attach(filename, { path, contentType: filename.endsWith('.json') ? 'application/json' : 'text/plain' });
  return content;
}

export async function focusStaysInDialog(page: Page, dialog: Locator) {
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  const stops = await dialog.locator('button, input, a[href]').count();
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let index = 0; index <= stops; index++) {
      await page.keyboard.press(key);
      // Native Chromium dialogs permit browser chrome at a tab boundary. Body is
      // the reported active element there; the next key must return to the modal.
      if (await page.evaluate(() => document.activeElement === document.body)) await page.keyboard.press(key);
      expect(await dialog.evaluate(element => element.contains(document.activeElement)), `${key} focused background page content`).toBe(true);
    }
  }
}

export async function restoredFocus(page: Page, opener: Locator, testInfo: TestInfo, label: string) {
  await expect.soft(opener, `${label}: closing the dialog must restore keyboard focus to its opener`).toBeFocused({ timeout: 1000 });
  await testInfo.attach(`focus-after-${label}`, {
    body: JSON.stringify(await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      label: document.activeElement?.getAttribute('aria-label'),
      class: document.activeElement?.getAttribute('class'),
      text: document.activeElement?.textContent?.slice(0, 150),
    })), null, 2), contentType: 'application/json',
  });
}
