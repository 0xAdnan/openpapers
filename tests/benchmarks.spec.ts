import { test, expect, noHorizontalOverflow, screenshot } from './fixtures';
import { type BenchmarkResponse, type PaperBenchmarksResponse } from '../shared/benchmarks';
import { discoverBenchmarks } from '../shared/benchmark-discovery';
import type { Paper } from '../shared/types';

// Explicitly synthetic metadata: no live scores or scholarly claims are bundled.
const papers: Paper[] = Array.from({ length: 23 }, (_, i) => ({
  id: `W${90001 + i}`, title: `UI fixture ${i + 1}: ${i % 2 ? 'Defects4J study' : 'Program repair research'}`,
  authors: ['Synthetic UI author'], year: 2026 - Math.floor(i / 4), venue: 'Synthetic test venue', citations: i * 10,
  references: [], abstract: 'Synthetic UI fixture. We evaluate program repair using Defects4J. Not a real publication.',
  doi: null, url: `https://example.org/papers/${i}`, pdfUrl: i % 2 ? null : `https://example.org/papers/${i}.pdf`,
  openAccess: i % 2 === 0, topics: ['Software testing'],
}));
const publicationFor = (paper: Paper): BenchmarkResponse['results'][number]['publication'] => {
  const kind = (Number(paper.id.slice(1)) - 90001) % 3;
  return { kind: kind === 0 ? 'conference' : kind === 1 ? 'journal' : 'preprint', published: kind !== 2 };
};
const metadataCoverage: PaperBenchmarksResponse['coverage'] = { fields: ['title', 'abstract'],
  discovery: { status: 'unavailable', sources: [], limitations: 'Synthetic metadata fixture. Full text unavailable.' } };

async function mockBenchmarks(page: Parameters<typeof noHorizontalOverflow>[0]) {
  await page.route('**/api/benchmarks/papers?*', async route => {
    const params = new URL(route.request().url()).searchParams;
    const q = params.get('q') ?? '';
    let selected = /defects\s*4j/i.test(q) ? [...papers] : [];
    const publication = params.get('publication') ?? 'any';
    if (publication !== 'any') selected = selected.filter(paper => publication === 'published' ? publicationFor(paper).published : publicationFor(paper).kind === publication);
    if (params.get('oa') === '1') selected = selected.filter(paper => paper.openAccess);
    if (params.get('pdf') === '1') selected = selected.filter(paper => paper.pdfUrl);
    if (params.has('from')) selected = selected.filter(paper => paper.year! >= Number(params.get('from')));
    if (params.has('to')) selected = selected.filter(paper => paper.year! <= Number(params.get('to')));
    if (params.get('evidence') === 'title') selected = selected.filter(paper => paper.title.includes('Defects4J'));
    if (params.get('keyword')) selected = selected.filter(paper => `${paper.title} ${paper.abstract}`.toLowerCase().includes(params.get('keyword')!.toLowerCase()));
    selected.sort((a, b) => params.get('sort') === 'oldest' ? a.year! - b.year! : params.get('sort') === 'citations' ? b.citations - a.citations : b.year! - a.year!);
    const pageNumber = Number(params.get('page') ?? 1);
    const body: BenchmarkResponse = {
      benchmark: { name: /defects/i.test(q) ? 'Defects4J' : q, aliases: [q], url: /defects/i.test(q) ? 'https://github.com/rjust/defects4j' : null },
      results: selected.slice((pageNumber - 1) * 20, pageNumber * 20).map((paper, i) => ({ paper, publicationDate: `${paper.year}-06-01`,
        publication: publicationFor(paper),
        evidence: { kind: i === 2 ? 'indexed' : paper.title.includes('Defects4J') ? 'title' : 'abstract', excerpt: i === 2 ? '' : 'Synthetic UI evidence: We evaluate using Defects4J.' } })),
      total: selected.length, page: pageNumber, perPage: 20,
      meta: { provider: 'openalex', source: 'live', fetchedAt: '2026-10-21T09:00:00Z',
        coverage: 'Synthetic UI fixture. Indexed matches are not a verified list of benchmark users. Check the source paper.' },
    };
    await route.fulfill({ json: body });
  });
}

test('benchmark discovery accepts a simple request, paginates, saves papers, and keeps filter URLs', async ({ page }, testInfo) => {
  await mockBenchmarks(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Benchmarks' }).click();
  await expect(page.getByRole('heading', { name: 'Benchmark papers', exact: true })).toBeVisible();
  await page.getByLabel('Benchmark', { exact: true }).fill('the benchmark is defects 4j');
  await page.getByRole('button', { name: 'Find papers', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Papers mentioning Defects4J' })).toBeVisible();
  await expect(page.locator('.benchmark-results .paper-card')).toHaveCount(20);
  await expect(page.locator('.benchmark-evidence').nth(0)).toContainText('Abstract match');
  await expect(page.locator('.benchmark-evidence').nth(1)).toContainText('Title match');
  await expect(page.locator('.benchmark-evidence').nth(2)).toContainText('Indexed match');
  await expect(page.getByLabel('Sort by')).toHaveValue('newest');
  await page.getByText('What these matches mean', { exact: true }).click();
  await expect(page.locator('.benchmark-coverage')).toContainText('not a verified list');
  await screenshot(page, testInfo, 'benchmark-desktop');
  await page.screenshot({ path: testInfo.outputPath('benchmark-desktop-viewport.png') });
  await noHorizontalOverflow(page, testInfo, 'benchmark-desktop');
  const pagination = page.getByRole('navigation', { name: 'Benchmark result pages' });
  await pagination.getByRole('link', { name: 'Next' }).click();
  await expect(page).toHaveURL(url => url.searchParams.get('page') === '2');
  await expect(page.locator('.benchmark-results .paper-card')).toHaveCount(3);
  await page.getByLabel('From year').fill('2025');
  await page.getByLabel('To year').fill('2026');
  await page.getByRole('checkbox', { name: 'Open access only' }).check();
  await page.getByRole('checkbox', { name: 'PDF available' }).check();
  await page.getByLabel('Additional keyword').fill('program repair');
  await page.getByLabel('Sort by').selectOption('oldest');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page).toHaveURL(url => !url.searchParams.has('page') && url.searchParams.get('oa') === '1' && url.searchParams.get('sort') === 'oldest');
  await expect(page.locator('.benchmark-results .paper-card')).toHaveCount(4);
  await expect(page.locator('.paper-publication').first()).toContainText('2025');
  await page.reload();
  await expect(page.getByLabel('From year')).toHaveValue('2025');
  await expect(page.getByRole('checkbox', { name: 'Open access only' })).toBeChecked();
  await expect(page.getByLabel('Sort by')).toHaveValue('oldest');
  await page.locator('.benchmark-results .paper-card').first().getByRole('button', { name: /^Save / }).click();
  await expect(page.locator('.toast')).toContainText('Paper saved');
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Open access only' })).not.toBeChecked();
  await expect(page.getByLabel('From year')).toHaveValue('');
  await expect(page.getByLabel('Sort by')).toHaveValue('newest');
  await expect(page.locator('.benchmark-results .paper-card')).toHaveCount(20);
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: /^Library/ }).click();
  await expect(page.locator('.paper-card')).toHaveCount(1);
});

test('benchmark filters, empty results, invalid links and mobile layout are accessible', async ({ page }, testInfo) => {
  await mockBenchmarks(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/benchmarks?q=Defects4J&evidence=title');
  await expect(page.locator('.benchmark-results .paper-card')).toHaveCount(11);
  await expect(page.getByLabel('Match evidence')).toHaveValue('title');
  await noHorizontalOverflow(page, testInfo, 'benchmark-mobile');
  await screenshot(page, testInfo, 'benchmark-mobile');
  await page.screenshot({ path: testInfo.outputPath('benchmark-mobile-viewport.png') });
  const graph = page.locator('.benchmark-results .paper-card').first().getByRole('link', { name: 'Build graph', exact: true });
  await expect(graph).toHaveAttribute('href', /^\/graph\/W\d+\/graph$/);
  await page.getByLabel('Benchmark', { exact: true }).fill('NoSuchBenchmark');
  await page.getByRole('button', { name: 'Find papers', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No matching papers' })).toBeVisible();
  await page.goto('/benchmarks?q=Defects4J&sort=invalid');
  await expect(page.getByRole('alert')).toContainText('invalid benchmark filters');
  await page.getByLabel('Sort by').selectOption('newest');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.locator('.benchmark-results .paper-card')).toHaveCount(20);
  await page.getByLabel('Benchmark', { exact: true }).fill('name" OR "injection');
  await page.getByRole('button', { name: 'Find papers', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Enter a benchmark name');
});

test('benchmark failures can be retried without changing the query', async ({ page, diagnostics }) => {
  let attempts = 0;
  const path = '/api/benchmarks/papers?q=Defects4J';
  diagnostics.expectedFailureUrls.add(path);
  await page.route(`**${path}`, async route => {
    attempts++;
    if (attempts === 1) return route.fulfill({ status: 503, json: { error: 'Synthetic unavailable service' } });
    await route.fulfill({ json: { benchmark: { name: 'Defects4J', aliases: ['Defects4J'], url: null }, results: [], total: 0, page: 1, perPage: 20,
      meta: { provider: 'openalex', source: 'cache', fetchedAt: '2026-10-21T09:00:00Z', coverage: 'Synthetic UI fixture.' } } });
  });
  await page.goto('/benchmarks?q=Defects4J');
  await expect(page.getByRole('heading', { name: 'Benchmark search couldn’t load' })).toBeVisible();
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No matching papers' })).toBeVisible();
  expect(attempts).toBe(2);
});

test('real offline benchmark API shows honest coverage rather than fabricated papers', async ({ page }) => {
  await page.goto('/benchmarks?q=Defects4J');
  await expect(page.getByRole('heading', { name: 'Papers mentioning Defects4J' })).toBeVisible();
  await expect(page.locator('.notice')).toContainText('Offline mode');
  await page.getByText('What these matches mean', { exact: true }).click();
  await expect(page.locator('.benchmark-coverage')).toContainText('does not prove evaluation');
});

test('publication filters persist, exclude preprints, and clear to all papers', async ({ page }, testInfo) => {
  await mockBenchmarks(page);
  await page.goto('/benchmarks?q=Defects4J');
  await page.getByRole('combobox', { name: 'Publication', exact: true }).selectOption('published');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page).toHaveURL(url => url.searchParams.get('publication') === 'published');
  await expect(page.locator('.benchmark-results .paper-card')).toHaveCount(16);
  await expect(page.locator('.benchmark-publication-kind').filter({ hasText: 'Preprint' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Publication', exact: true })).toHaveValue('published');
  await page.getByRole('combobox', { name: 'Publication', exact: true }).selectOption('conference');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.locator('.benchmark-results .paper-card')).toHaveCount(8);
  await expect(page.locator('.benchmark-publication-kind').filter({ hasText: 'Conference paper' })).toHaveCount(8);
  await screenshot(page, testInfo, 'benchmark-conferences');
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Publication', exact: true })).toHaveValue('any');
  await expect(page.locator('.benchmark-results .paper-card')).toHaveCount(20);
});

test('by-paper discovery requires selection, shows official links, and works on mobile', async ({ page }, testInfo) => {
  const paper = { ...papers[0], title: 'UI fixture: Repair evaluation', abstract: 'We evaluate on NebulaBench and AuroraSet benchmarks. Not a real publication.' };
  await page.route('**/api/search?*', async route => {
    await route.fulfill({ json: { results: [paper], total: 1, page: 1, perPage: 20, meta: { provider: 'openalex', source: 'live', fetchedAt: '2026-10-21T09:00:00Z' } } });
  });
  await page.route(`**/api/paper/${paper.id}/benchmarks`, async route => {
    const body: PaperBenchmarksResponse = { paper, benchmarks: discoverBenchmarks({ kind: 'abstract', text: paper.abstract, url: paper.url }),
      coverage: metadataCoverage, meta: { provider: 'openalex', source: 'live', fetchedAt: '2026-10-21T09:00:00Z' } };
    await route.fulfill({ json: body });
  });
  await page.goto('/benchmarks');
  await page.getByRole('navigation', { name: 'Benchmark discovery direction' }).getByRole('link', { name: 'By paper', exact: true }).click();
  await page.getByLabel('Paper title, DOI, or link', { exact: true }).fill('Repair evaluation');
  await page.getByRole('button', { name: 'Find paper', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Choose a paper', exact: true })).toBeVisible();
  await expect(page.locator('.paper-benchmark-card')).toHaveCount(0);
  await page.locator('.paper-card').getByRole('link', { name: 'Find benchmarks' }).click();
  await expect(page).toHaveURL(url => url.searchParams.get('id') === paper.id && url.searchParams.get('q') === 'Repair evaluation');
  await expect(page.getByRole('heading', { name: '2 benchmarks and evaluation suites', exact: true })).toBeVisible();
  const benchmark = page.locator('.paper-benchmark-card').filter({ has: page.getByRole('heading', { name: 'NebulaBench', exact: true }) });
  await expect(benchmark.getByRole('link', { name: 'Availability', exact: true })).toHaveCount(0);
  await expect(benchmark).toContainText('Named benchmark · Abstract');
  await expect(benchmark.getByRole('link', { name: 'Papers mentioning NebulaBench' })).toHaveAttribute('href', '/benchmarks?q=NebulaBench');
  await expect(benchmark.getByRole('link', { name: 'View evidence' })).toHaveAttribute('href', paper.url);
  await expect(page.getByText('Full text could not be checked. Results may be incomplete.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('.paper-benchmark-card')).toHaveCount(2);
  await screenshot(page, testInfo, 'paper-benchmarks-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await noHorizontalOverflow(page, testInfo, 'paper-benchmarks-mobile');
  await screenshot(page, testInfo, 'paper-benchmarks-mobile');
  await page.getByRole('link', { name: 'Back to papers', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Choose a paper', exact: true })).toBeVisible();
});

test('by-paper empty metadata and request errors offer honest, recoverable states', async ({ page, diagnostics }) => {
  const paper = { ...papers[0], title: 'UI fixture: Uncatalogued benchmark', abstract: '' };
  await page.route(`**/api/paper/${paper.id}/benchmarks`, async route => {
    await route.fulfill({ json: { paper, benchmarks: [], coverage: { ...metadataCoverage, fields: ['title'] },
      meta: { provider: 'openalex', source: 'cache', fetchedAt: '2026-10-21T09:00:00Z' } } });
  });
  await page.goto(`/benchmarks/paper?id=${paper.id}`);
  await expect(page.getByRole('heading', { name: 'No benchmarks found in available data', exact: true })).toBeVisible();
  await expect(page.getByText(/Checked: title · abstract unavailable/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open paper', exact: true })).toHaveAttribute('href', paper.pdfUrl!);
  const failure = '/api/paper/W99999/benchmarks';
  diagnostics.expectedFailureUrls.add(failure);
  let attempts = 0;
  await page.route(`**${failure}`, async route => {
    attempts++;
    if (attempts === 1) return route.fulfill({ status: 503, json: { error: 'Synthetic metadata outage' } });
    await route.fulfill({ json: { paper: { ...paper, id: 'W99999' }, benchmarks: [], coverage: { ...metadataCoverage, fields: ['title'] },
      meta: { provider: 'openalex', source: 'cache', fetchedAt: '2026-10-21T09:00:00Z' } } });
  });
  await page.goto('/benchmarks/paper?id=W99999');
  await expect(page.getByRole('heading', { name: 'Paper couldn’t load', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No benchmarks found in available data', exact: true })).toBeVisible();
  expect(attempts).toBe(2);
});

test('uncatalogued suites show full-text evidence, artifact availability and no misleading name search', async ({ page }, testInfo) => {
  const paper = { ...papers[0], title: 'UI fixture: Partial repair abstract', abstract: 'Synthetic partial abstract without benchmark names.' };
  await page.route(`**/api/paper/${paper.id}/benchmarks`, async route => {
    const body: PaperBenchmarksResponse = { paper,
      benchmarks: [{ name: '23 real-world repositories', category: 'suite', url: 'https://example.org/artifact',
        evidence: { kind: 'fulltext', excerpt: 'We evaluate on 23 real-world repositories.', sourceUrl: paper.pdfUrl!, section: 'Evaluation setup' } }],
      coverage: { fields: ['title', 'abstract', 'fulltext', 'artifact'], discovery: { status: 'complete', limitations: 'Synthetic fixture; suites may overlap.',
        sources: [{ kind: 'fulltext', url: paper.pdfUrl!, status: 'read' }] } },
      meta: { provider: 'openalex', source: 'cache', fetchedAt: '2026-10-21T09:00:00Z' } };
    await route.fulfill({ json: body });
  });
  await page.goto(`/benchmarks/paper?id=${paper.id}`);
  await expect(page.getByRole('heading', { name: '1 benchmark or evaluation suite', exact: true })).toBeVisible();
  await expect(page.locator('.paper-benchmark-card')).toContainText('Evaluation suite · Paper full text · Evaluation setup');
  await expect(page.locator('.paper-benchmark-card')).toContainText('We evaluate on 23 real-world repositories.');
  await expect(page.getByRole('link', { name: 'Availability', exact: true })).toHaveAttribute('href', 'https://example.org/artifact');
  await expect(page.getByRole('link', { name: /^Papers mentioning/ })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await noHorizontalOverflow(page, testInfo, 'suite-discovery-mobile');
  await screenshot(page, testInfo, 'suite-discovery-mobile');
});
