import type { GraphPaper, GraphResponse, SearchResponse } from '../shared/types';
import { test, expect, EXAMPLES, S2_SAVED_PAPERS, nodes, details, graphPapers, views, openGraph, selectPaper,
  noHorizontalOverflow, screenshot, download, focusStaysInDialog, restoredFocus } from './fixtures';

// Exercise the production 60-request/minute limit without burst-loading the full suite.
test.afterEach(async () => { await new Promise(resolve => setTimeout(resolve, 15000)); });

test('malformed persisted papers are ignored instead of crashing the library', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('open-papers-library', JSON.stringify([{ id: 'W1234', title: 'Invalid persisted paper', authors: ['A'], year: { invalid: true }, citations: 1, venue: '', references: [], abstract: '', doi: 42, url: 'javascript:alert(1)', pdfUrl: null, openAccess: false, topics: [null] }]));
  });
  await page.goto('/library');
  await expect(page.getByRole('heading', { name: 'A home for your next discovery' })).toBeVisible();
  await expect(page.locator('.paper-card')).toHaveCount(0);
});

test('concurrent saves in two tabs retain both papers', async ({ page, context }) => {
  await openGraph(page);
  const other = await context.newPage();
  await openGraph(other, EXAMPLES[1].id);
  await Promise.all([
    details(page).getByRole('button', { name: `Save ${EXAMPLES[0].title}`, exact: true }).click(),
    details(other).getByRole('button', { name: `Save ${EXAMPLES[1].title}`, exact: true }).click(),
  ]);
  await page.goto('/library');
  await expect(page.locator('.paper-card')).toHaveCount(2);
  await expect(page.getByRole('heading', { name: EXAMPLES[0].title, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: EXAMPLES[1].title, exact: true })).toBeVisible();
  await other.close();
});

test('homepage offers three real example links, each opening a 40-node SVG graph', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Explore academic papersin a visual graph');
  await expect(page.locator('.example-card')).toHaveCount(3);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/#main$/);
  await noHorizontalOverflow(page, testInfo, 'home');
  await screenshot(page, testInfo, 'desktop-home');
  for (const example of EXAMPLES) {
    const link = page.getByRole('link').filter({ has: page.getByRole('heading', { name: example.title, exact: true }) });
    await expect(link).toHaveAttribute('href', `/graph/${example.id}/graph`);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/graph/${example.id}/graph$`));
    await expect(nodes(page)).toHaveCount(40);
    await expect(page.locator('svg.graph-svg g.graph-node--origin')).toHaveCount(1);
    await expect(details(page).getByRole('heading', { name: example.title, exact: true })).toBeVisible();
    await expect(graphPapers(page).getByRole('button')).toHaveCount(40);
    await expect(page.locator('.graph-summary')).toContainText('40 papers');
    await noHorizontalOverflow(page, testInfo, example.id);
    await page.getByRole('link', { name: 'Open Papers home', exact: true }).click();
  }
});

test('paper selection synchronizes SVG, details, evidence, URL and reload', async ({ page }, testInfo) => {
  const graph = await openGraph(page);
  const paper = graph.nodes.find(paper => !paper.isOrigin && paper.abstract)!;
  const node = page.locator(`g[data-paper-id="${paper.id}"]`);
  await node.locator('.graph-node-disc').click();
  await expect(page).toHaveURL(url => url.searchParams.get('selected') === paper.id);
  await expect(node).toHaveAttribute('aria-pressed', 'true');
  await expect(details(page).getByRole('heading', { name: paper.title, exact: true })).toBeVisible();
  await expect(details(page).locator('.detail-abstract')).toHaveText(paper.abstract);
  await expect(details(page).locator('dd')).toHaveText([
    `${(paper.similarity * 100).toFixed(1)}%`, String(paper.sharedReferences), String(paper.coCitations), String(paper.references.length),
  ]);
  await expect(graphPapers(page).locator('.selected strong')).toHaveText(paper.title);
  await expect(page.locator('.graph-selection-title')).toHaveText(paper.title);
  await expect(page.getByRole('region', { name: 'Paper similarity graph', exact: true }).getByRole('status')).toContainText(paper.title);
  await page.reload();
  await expect(node).toHaveAttribute('aria-pressed', 'true');
  await expect(details(page).getByRole('heading', { name: paper.title, exact: true })).toBeVisible();
  const other = graph.nodes.find(candidate => candidate.id !== paper.id && !candidate.isOrigin)!;
  await selectPaper(page, other);
  await expect(node).toHaveAttribute('aria-pressed', 'false');
  await screenshot(page, testInfo, 'desktop-selected-graph');
});

test('prior, derivative and list views navigate, sort real rows and select details', async ({ page }, testInfo) => {
  const graph = await openGraph(page);
  for (const [view, name, source, score] of [
    ['prior', 'Prior works', graph.prior, 'Graph citations'],
    ['derivative', 'Derivative works', graph.derivative, 'Graph references'],
    ['list', 'List view', graph.nodes, 'Similarity'],
  ] as const) {
    await views(page).getByRole('link', { name, exact: true }).click();
    await expect(page).toHaveURL(url => url.pathname.endsWith(`/${view}`));
    await expect(page.getByRole('heading', { name: view === 'list' ? 'All graph papers' : name, exact: true })).toBeVisible();
    expect(source.length).toBeGreaterThan(1);
    const rows = page.locator('tbody tr');
    await expect(rows).toHaveCount(source.length);
    const titles = () => rows.locator('.table-title').allTextContents();
    for (const label of ['Year', 'Title', 'Citations', score]) {
      const header = page.getByRole('columnheader').filter({ has: page.getByRole('button', { name: label, exact: true }) });
      const key = label === 'Year' ? 'year' : label === 'Title' ? 'title' : label === 'Citations' ? 'citations' : view === 'list' ? 'similarity' : 'graphConnections';
      for (let iteration = 0; iteration < 2; iteration++) {
        await header.getByRole('button').click();
        const order = await header.getAttribute('aria-sort');
        expect(['ascending', 'descending']).toContain(order);
        const expected = [...source].sort((a, b) => {
          const av = a[key], bv = b[key];
          const comparison = typeof av === 'string' && typeof bv === 'string' ? av.localeCompare(bv) : Number(av ?? -1) - Number(bv ?? -1);
          return (order === 'descending' ? -comparison : comparison) || a.id.localeCompare(b.id);
        });
        await expect.poll(titles).toEqual(expected.map(paper => paper.title));
      }
    }
    const chosen = source.find(paper => !paper.isOrigin)!;
    await page.getByRole('button', { name: chosen.title, exact: true }).click();
    await expect(page).toHaveURL(url => url.searchParams.get('selected') === chosen.id);
    await expect(details(page).getByRole('heading', { name: chosen.title, exact: true })).toBeVisible();
    await noHorizontalOverflow(page, testInfo, view);
  }
  await views(page).getByRole('link', { name: 'Graph', exact: true }).click();
  await expect(nodes(page)).toHaveCount(40);
});

test('OA, year, keyword and PDF filters apply, compose, restore from URL and clear', async ({ page }) => {
  const graph = await openGraph(page);
  const candidate = graph.nodes.find(paper => !paper.isOrigin && paper.openAccess && paper.pdfUrl && paper.year)!;
  const keyword = candidate.title.split(/\s+/).find(word => /^[a-z]{4,}$/i.test(word))!;
  expect(keyword).toBeTruthy();
  await selectPaper(page, candidate);
  const filterButton = page.getByRole('button', { name: 'Filter papers', exact: true });
  const assertFiltered = async (predicate: (paper: GraphPaper) => boolean) => {
    const expected = graph.nodes.filter(paper => paper.isOrigin || predicate(paper));
    expect(expected.length).toBeLessThan(graph.nodes.length);
    await expect(nodes(page)).toHaveCount(expected.length);
    expect((await nodes(page).evaluateAll(elements => elements.map(element => element.getAttribute('data-paper-id')))).sort())
      .toEqual(expected.map(paper => paper.id).sort());
    await expect(graphPapers(page).getByRole('button')).toHaveCount(expected.length);
    await expect(page.locator('.graph-summary')).toContainText(`${expected.length} papers`);
  };
  for (const kind of ['oa', 'year', 'keyword'] as const) {
    await filterButton.click();
    const dialog = page.getByRole('dialog', { name: 'Filter graph papers' });
    if (kind === 'oa') await dialog.getByRole('checkbox', { name: 'Open access only' }).check();
    if (kind === 'year') {
      await dialog.getByLabel('From year').fill(String(candidate.year));
      await dialog.getByLabel('To year').fill(String(candidate.year));
    }
    if (kind === 'keyword') await dialog.getByLabel('Title or author').fill(keyword);
    await dialog.getByRole('button', { name: 'Apply filters' }).click();
    await expect(dialog).not.toBeVisible();
    await assertFiltered(paper => kind === 'oa' ? paper.openAccess : kind === 'year' ? paper.year === candidate.year :
      `${paper.title} ${paper.authors.slice(0, 3).join(', ')}`.toLowerCase().includes(keyword.toLowerCase()));
    await filterButton.click();
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await expect(nodes(page)).toHaveCount(40);
    await expect(page).toHaveURL(url => url.searchParams.size === 1 && url.searchParams.get('selected') === candidate.id);
  }
  await filterButton.click();
  let dialog = page.getByRole('dialog', { name: 'Filter graph papers' });
  await dialog.getByLabel('Title or author').fill(keyword);
  await dialog.getByLabel('From year').fill(String(candidate.year));
  await dialog.getByLabel('To year').fill(String(candidate.year));
  await dialog.getByRole('checkbox', { name: 'Open access only' }).check();
  await dialog.getByRole('checkbox', { name: 'PDF available' }).check();
  await dialog.getByRole('button', { name: 'Apply filters' }).click();
  const predicate = (paper: GraphPaper) => paper.openAccess && Boolean(paper.pdfUrl) && paper.year === candidate.year &&
    `${paper.title} ${paper.authors.slice(0, 3).join(', ')}`.toLowerCase().includes(keyword.toLowerCase());
  await assertFiltered(predicate);
  const restoredUrl = page.url();
  expect(Object.fromEntries(new URL(restoredUrl).searchParams)).toEqual({
    selected: candidate.id, keyword, from: String(candidate.year), to: String(candidate.year), oa: '1', pdf: '1',
  });
  await page.getByRole('link', { name: 'Open Papers home', exact: true }).click();
  await page.goto(restoredUrl);
  await assertFiltered(predicate);
  await expect(details(page).getByRole('heading', { name: candidate.title, exact: true })).toBeVisible();
  await filterButton.click();
  dialog = page.getByRole('dialog', { name: 'Filter graph papers' });
  await expect(dialog.getByLabel('Title or author')).toHaveValue(keyword);
  await expect(dialog.getByLabel('From year')).toHaveValue(String(candidate.year));
  await expect(dialog.getByLabel('To year')).toHaveValue(String(candidate.year));
  await expect(dialog.getByRole('checkbox', { name: 'Open access only' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'PDF available' })).toBeChecked();
  await dialog.getByRole('button', { name: 'Clear filters' }).click();
  await expect(nodes(page)).toHaveCount(40);
  await expect(page).toHaveURL(url => url.searchParams.size === 1);
  // A zero-match filter must still retain every origin.
  await filterButton.click();
  await page.getByLabel('Title or author').fill('zzzz-no-paper-matches-qa');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(nodes(page)).toHaveCount(1);
  await expect(nodes(page)).toHaveAttribute('data-paper-id', graph.origins[0]);
  await filterButton.click();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(nodes(page)).toHaveCount(40);
});

test('modal dialogs trap keyboard focus, cancel cleanly and validate reversed years', async ({ page }, testInfo) => {
  await openGraph(page);
  for (const [buttonName, title] of [
    ['Filter papers', 'Filter graph papers'], ['Export graph', 'Export your research'], ['Coverage & methodology', 'Data & methodology'],
  ]) {
    const opener = page.getByRole('button', { name: buttonName, exact: true });
    await opener.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: title, exact: true });
    await focusStaysInDialog(page, dialog);
    await noHorizontalOverflow(page, testInfo, title);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await restoredFocus(page, opener, testInfo, title);
  }
  const original = page.url();
  await page.getByRole('button', { name: 'Filter papers', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Filter graph papers' });
  await dialog.getByLabel('From year').fill('2024');
  await dialog.getByLabel('To year').fill('2010');
  await dialog.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.locator('.toast')).toContainText('The start year must be before the end year.');
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(original);
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await expect(nodes(page)).toHaveCount(40);
});

test('saving to the local library persists reload, filters and removes without resurrection', async ({ page }, testInfo) => {
  const graph = await openGraph(page);
  const paper = graph.nodes.find(paper => !paper.isOrigin)!;
  await selectPaper(page, paper);
  await details(page).getByRole('button', { name: `Save ${paper.title}`, exact: true }).click();
  await expect(details(page).getByRole('button', { name: `Unsave ${paper.title}`, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.toast')).toContainText('Paper saved on this device.');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: /^Library/ }).click();
  await expect(page.locator('.library-row')).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole('heading', { name: paper.title, exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Filter saved papers' }).fill('no-saved-paper-matches-qa');
  await expect(page.getByRole('heading', { name: 'No saved papers match' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(page.locator('.library-row')).toHaveCount(1);
  const bib = await download(page, page.getByRole('button', { name: 'BibTeX', exact: true }), 'open-papers.bib', testInfo);
  expect(bib.match(/^@article\{/gm)).toHaveLength(1);
  expect(bib).toContain(`@article{${paper.id},`);
  const csv = await download(page, page.getByRole('button', { name: 'CSV', exact: true }), 'open-papers.csv', testInfo);
  expect(csv).toContain(`"${paper.title.replaceAll('"', '""')}"`);
  expect(csv.split('\r\n')).toHaveLength(2);
  await page.getByRole('button', { name: `Remove ${paper.title}`, exact: true }).click();
  await expect(page.locator('.library-row')).toHaveCount(0);
  await expect(page.locator('.toast')).toContainText('Paper removed from your library.');
  await page.reload();
  await expect(page.locator('.library-row')).toHaveCount(0);
  await page.goto(`/graph/${graph.origins[0]}/graph?selected=${paper.id}`);
  await expect(details(page).getByRole('button', { name: `Save ${paper.title}`, exact: true })).toHaveAttribute('aria-pressed', 'false');
});

test('graph exports download complete BibTeX, correctly quoted CSV and evidenced JSON despite display filters', async ({ page }, testInfo) => {
  const graph = await openGraph(page);
  await page.getByRole('button', { name: 'Filter papers', exact: true }).click();
  await page.getByLabel('Title or author').fill('zzzz-export-filter-qa');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(nodes(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'Export graph', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export your research' });
  await expect(dialog).toContainText('Export all 40 graph papers.');
  const bib = await download(page, dialog.getByRole('button', { name: /BibTeX bibliography/ }), 'open-papers.bib', testInfo);
  expect(bib.match(/^@article\{/gm)).toHaveLength(40);
  const csv = await download(page, dialog.getByRole('button', { name: /CSV paper list/ }), 'open-papers.csv', testInfo);
  // Parse quotes and embedded line breaks rather than assuming one line per paper.
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];
    if (char === '"') {
      if (quoted && csv[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
    } else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
    else if (char === '\r' && csv[i + 1] === '\n' && !quoted) {
      row.push(cell); rows.push(row); row = []; cell = ''; i++;
    } else cell += char;
  }
  row.push(cell); rows.push(row);
  expect(quoted).toBe(false);
  expect(rows[0]).toEqual(['Title', 'Authors', 'Year', 'Citations', 'DOI', 'Paper ID', 'Source']);
  expect(rows).toHaveLength(41);
  for (const [index, paper] of graph.nodes.entries()) {
    expect(bib).toContain(`@article{${paper.id},`);
    expect(bib).toContain(`url = {https://openalex.org/${paper.id}}`);
    const safe = (value: unknown) => { const text = String(value ?? ''); return /^[=+@\-\t\r]/.test(text) ? `'${text}` : text; };
    expect(rows[index + 1]).toEqual([paper.title, paper.authors.join('; '), paper.year, paper.citations, paper.doi, paper.id, 'OpenAlex'].map(safe));
  }
  const json: GraphResponse = JSON.parse(await download(page, dialog.getByRole('button', { name: /Full graph JSON/ }), 'open-papers-graph.json', testInfo));
  expect(json).toEqual(graph);
  expect(json.edges.length).toBeGreaterThan(0);
  expect(json.meta.algorithm).toBeTruthy();
  expect(json.meta.coverage).toBeTruthy();
  expect(json.nodes.map(paper => paper.id)).toEqual(graph.nodes.map(paper => paper.id));
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
});

test('title and DOI searches resolve real papers, and autocomplete supports keyboard selection', async ({ page }) => {
  for (const query of ['Attention Is All You Need', '10.48550/arXiv.1706.03762']) {
    await page.goto('/');
    const input = page.locator('main').getByRole('textbox', { name: 'Search academic papers' });
    await input.fill(query);
    await page.getByRole('button', { name: 'Build a graph', exact: true }).click();
    await expect(page).toHaveURL(url => url.pathname === '/search' && url.searchParams.get('q') === query);
    await expect(page.locator('.paper-card').first().getByRole('heading')).toHaveText(EXAMPLES[0].title);
    await expect(page.locator('.notice')).toContainText(/Offline/);
    await page.locator('.paper-card').first().getByRole('link', { name: 'Build graph', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/graph/${EXAMPLES[0].id}/graph$`));
    await expect(nodes(page)).toHaveCount(40);
  }
  await page.goto('/');
  const input = page.locator('main').getByRole('textbox', { name: 'Search academic papers' });
  await input.fill(EXAMPLES[0].title);
  await expect(page.locator('#main-suggestions .suggestion').first()).toContainText(EXAMPLES[0].title);
  await input.press('ArrowDown');
  await expect(page.locator('#main-suggestions .suggestion').first()).toHaveClass(/active/);
  await input.press('Escape');
  await expect(page.locator('#main-suggestions')).not.toBeVisible();
  await expect(input).toBeFocused();
  await input.press('Tab');
  await input.focus();
  await expect(page.locator('#main-suggestions .suggestion').first()).toBeVisible();
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/graph/${EXAMPLES[0].id}/graph$`));
  await expect(nodes(page)).toHaveCount(40);
});

test('keyword search paginates distinct actual results, restores pages and has a useful empty state', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.locator('main').getByRole('textbox', { name: 'Search academic papers' }).fill('learning');
  const pending = page.waitForResponse(response => response.url().includes('/api/search?q=learning&page=1'));
  await page.getByRole('button', { name: 'Build a graph', exact: true }).click();
  const data: SearchResponse = await (await pending).json();
  expect(data.total).toBeGreaterThan(data.perPage);
  await expect(page.locator('.paper-card')).toHaveCount(data.perPage);
  const firstPage = await page.locator('.paper-card h2').allTextContents();
  const firstIds = data.results.map(paper => paper.id);
  const pagination = page.getByRole('navigation', { name: 'Search result pages' });
  await expect(pagination.getByRole('link', { name: 'Previous' })).toHaveCount(0);
  await pagination.getByRole('link', { name: 'Next', exact: true }).click();
  await expect(page).toHaveURL(url => url.searchParams.get('page') === '2' && url.searchParams.get('q') === 'learning' && url.searchParams.get('provider') === 'openalex');
  await expect(pagination.getByRole('link', { name: 'Previous', exact: true })).toHaveAttribute('href', '/search?q=learning&page=1&provider=openalex');
  await expect(pagination).toContainText(`Page 2 of ${Math.ceil(data.total / data.perPage)}`);
  await expect(page.locator('.paper-card')).toHaveCount(Math.min(data.perPage, data.total - data.perPage));
  const secondPage = await page.locator('.paper-card h2').allTextContents();
  // Distinct provider records can share a title (for example a preprint and publication).
  const secondLinks = await page.locator('.paper-card-top>a').evaluateAll(links => links.map(link => link.getAttribute('href')));
  expect(secondLinks.some(link => firstIds.some(id => link === `/graph/${id}/graph`))).toBe(false);
  await page.reload();
  await expect(page.locator('.paper-card h2')).toHaveText(secondPage);
  await pagination.getByRole('link', { name: 'Previous', exact: true }).click();
  await expect(page.locator('.paper-card h2')).toHaveText(firstPage);
  await page.goBack();
  await expect(page.locator('.paper-card h2')).toHaveText(secondPage);
  await noHorizontalOverflow(page, testInfo, 'search-page-2');
  await page.goto('/search?q=zzzz-no-search-results-qa');
  await expect(page.getByRole('heading', { name: 'No matching papers', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Search result pages' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Back to discovery' }).click();
  await expect(page.locator('.example-card')).toHaveCount(3);
});

test('server default, provider switching and unavailable Semantic Scholar pages retain source URLs', async ({ page, diagnostics }, testInfo) => {
  const providersResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/providers');
  await page.goto('/');
  const config = await (await providersResponse).json();
  const selector = page.locator('main').getByRole('combobox', { name: 'Data source', exact: true });
  await expect(selector).toHaveValue(config.defaultProvider);
  await expect(selector.getByRole('option')).toHaveText(config.providers.map((item: { name: string }) => item.name));
  await expect(page.locator('.section-top')).toContainText('OpenAlex example graph');
  await selector.selectOption('openalex');
  await page.locator('main').getByRole('textbox', { name: 'Search academic papers' }).fill('learning');
  await page.getByRole('button', { name: 'Build a graph', exact: true }).click();
  await expect(page.locator('.paper-card')).toHaveCount(20);
  await page.getByRole('navigation', { name: 'Search result pages' }).getByRole('link', { name: 'Next', exact: true }).click();
  await expect(page).toHaveURL(url => url.searchParams.get('provider') === 'openalex' && url.searchParams.get('page') === '2');
  diagnostics.expectedFailureUrls.add('/api/search?q=learning&page=1&provider=semantic-scholar');
  const changed = page.waitForResponse(response => response.url().endsWith('/api/search?q=learning&page=1&provider=semantic-scholar'));
  await selector.selectOption('semantic-scholar');
  expect((await changed).status()).toBe(503);
  await expect(page).toHaveURL(url => url.searchParams.get('provider') === 'semantic-scholar' && !url.searchParams.has('page'));
  await expect(page.locator('.paper-card')).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('no matching Semantic Scholar cache exists');
  await expect(selector).toHaveValue('semantic-scholar');
  await expect(page.getByRole('navigation', { name: 'Search result pages' })).toHaveCount(0);
  await page.reload();
  await expect(selector).toHaveValue('semantic-scholar');
  await expect(page.getByRole('alert')).toContainText('No OpenAlex data is returned as Semantic Scholar');
  diagnostics.expectedFailureUrls.add('/api/search?q=learning&page=2&provider=semantic-scholar');
  const pageTwo = page.waitForResponse(response => response.url().endsWith('/api/search?q=learning&page=2&provider=semantic-scholar'));
  await page.goto('/search?q=learning&page=2&provider=semantic-scholar');
  expect((await pageTwo).status()).toBe(503);
  await expect(page).toHaveURL(url => url.searchParams.get('page') === '2' && url.searchParams.get('provider') === 'semantic-scholar');
  await expect(page.getByRole('alert')).toContainText('Semantic Scholar unavailable');
  await noHorizontalOverflow(page, testInfo, 'semantic-scholar-offline');
  await page.getByRole('link', { name: 'Back to discovery' }).click();
  await expect(selector).toHaveValue('semantic-scholar');
  await page.locator('.example-card').first().click();
  await expect(nodes(page)).toHaveCount(40);
  await expect(page.locator('.data-badge')).toContainText('OpenAlex');
  await expect(details(page).getByRole('link', { name: 'OpenAlex', exact: true })).toHaveAttribute('href', `https://openalex.org/${EXAMPLES[0].id}`);
});

test('autocomplete clears active papers when switching provider and preserves source on submit and see all', async ({ page, diagnostics }) => {
  await page.goto('/?provider=openalex');
  const input = page.locator('main').getByRole('textbox', { name: 'Search academic papers' });
  await input.fill(EXAMPLES[0].title);
  await expect(page.locator('#main-suggestions .suggestion').first()).toBeVisible();
  await input.press('ArrowDown');
  await expect(page.locator('#main-suggestions .suggestion.active')).toHaveCount(1);
  diagnostics.expectedFailureUrls.add(`/api/search?q=${encodeURIComponent(EXAMPLES[0].title)}&page=1&provider=semantic-scholar`);
  await page.locator('main').getByRole('combobox', { name: 'Data source', exact: true }).selectOption('semantic-scholar');
  await input.focus();
  await expect(page.locator('#main-suggestions .suggestion')).toHaveCount(0);
  await expect(page.locator('#main-suggestions .suggestion-status')).toContainText('Semantic Scholar unavailable');
  await input.press('Enter');
  await expect(page).toHaveURL(url => url.pathname === '/search' && url.searchParams.get('provider') === 'semantic-scholar');
  await expect(page.getByRole('alert')).toContainText('Semantic Scholar unavailable');
  await input.focus();
  await expect(page.locator('#main-suggestions .suggestion-status')).toContainText('Semantic Scholar unavailable');
  await page.getByRole('button', { name: 'See all paper suggestions' }).click();
  await expect(page).toHaveURL(url => url.searchParams.get('provider') === 'semantic-scholar' && url.searchParams.get('q') === EXAMPLES[0].title);
  await page.locator('main').getByRole('combobox', { name: 'Data source', exact: true }).selectOption('openalex');
  await expect(page.locator('.paper-card').first().getByRole('heading')).toHaveText(EXAMPLES[0].title);
  const unknown = '/api/search?q=learning&page=2&provider=unknown-source';
  diagnostics.expectedFailureUrls.add(unknown);
  const invalid = page.waitForResponse(response => response.url().endsWith(unknown));
  await page.goto('/search?q=learning&page=2&provider=unknown-source');
  expect((await invalid).status()).toBe(400);
  await expect(page.getByRole('alert')).toContainText('Provider must be openalex or semantic-scholar');
  await expect(page).toHaveURL(url => url.searchParams.get('provider') === 'unknown-source' && url.searchParams.get('page') === '2');
});

test('mixed-source saved papers preserve selections and download source-aware citations', async ({ page, request, diagnostics }, testInfo) => {
  const response = await request.get(`/api/paper/${EXAMPLES[0].id}`);
  expect(response.ok()).toBe(true);
  const { paper: openalex } = await response.json();
  await page.addInitScript(papers => localStorage.setItem('open-papers-library', JSON.stringify(papers)), [openalex, ...S2_SAVED_PAPERS]);
  await page.goto('/library');
  await expect(page.locator('.library-row')).toHaveCount(3);
  const s2 = S2_SAVED_PAPERS[0];
  const row = page.locator('.library-row').filter({ has: page.getByRole('heading', { name: s2.title, exact: true }) });
  await expect(row.getByRole('link', { name: 'Semantic Scholar', exact: true })).toHaveAttribute('href', s2.url);
  await expect(row.getByRole('link', { name: 'OpenAlex', exact: true })).toHaveCount(0);
  const checkbox = (title: string) => page.getByRole('checkbox', { name: `Select ${title} for combined graph`, exact: true });
  await checkbox(openalex.title).check();
  await checkbox(s2.title).click();
  await expect(checkbox(s2.title)).not.toBeChecked();
  await expect(checkbox(openalex.title)).toBeChecked();
  await expect(page.locator('.toast')).toContainText('same data source. Your selection is unchanged');
  await expect(page.getByRole('link', { name: 'Build combined graph (1)' })).toHaveAttribute('href', `/graph/${openalex.id}/graph`);
  await checkbox(openalex.title).uncheck();
  for (const paper of S2_SAVED_PAPERS) await checkbox(paper.title).check();
  await checkbox(openalex.title).click();
  await expect(checkbox(openalex.title)).not.toBeChecked();
  await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(2);
  await expect(page.getByRole('link', { name: 'Build combined graph (2)' })).toHaveAttribute('href', `/graph/${S2_SAVED_PAPERS.map(paper => paper.id).join(',')}/graph`);
  const bib = await download(page, page.getByRole('button', { name: 'BibTeX', exact: true }), 'open-papers.bib', testInfo);
  expect(bib.match(/^@article\{/gm)).toHaveLength(3);
  expect(bib).toContain(`url = {https://openalex.org/${openalex.id}}`);
  for (const paper of S2_SAVED_PAPERS) {
    expect(bib).toContain(`@article{${paper.id.replace(':', '')},`);
    expect(bib).toContain(`url = {${paper.url}}`);
  }
  expect(bib.match(/note = \{Data source: Semantic Scholar; API\/data terms apply\}/g)).toHaveLength(2);
  expect(bib).not.toContain('openalex.org/S2');
  const csv = await download(page, page.getByRole('button', { name: 'CSV', exact: true }), 'open-papers.csv', testInfo);
  expect(csv.split('\r\n')[0]).toBe('"Title","Authors","Year","Citations","DOI","Paper ID","Source"');
  expect(csv.match(/Data source: Semantic Scholar; API\/data terms apply/g)).toHaveLength(2);
  expect(csv).toContain(`"${s2.id}"`);
  await expect(page.locator('.site-footer')).toContainText('Code MIT / Data licenses');
  await expect(page.locator('.site-footer')).not.toContainText('MIT / CC0');
  diagnostics.expectedFailureUrls.add(`/api/graph?ids=${encodeURIComponent(s2.id)}`);
  const unavailable = page.waitForResponse(response => response.url().endsWith(`/api/graph?ids=${encodeURIComponent(s2.id)}`));
  await row.getByRole('link', { name: 'Open graph', exact: true }).click();
  expect((await unavailable).status()).toBe(503);
  await expect(page.getByRole('alert')).toContainText('no matching Semantic Scholar cache exists');
  await expect(nodes(page)).toHaveCount(0);
  await noHorizontalOverflow(page, testInfo, 'saved-s2-unavailable-graph');
});

test('mobile source selectors remain reachable on home, navigation and offline search without overflow', async ({ page, diagnostics }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.locator('main').getByRole('combobox', { name: 'Data source', exact: true }).selectOption('semantic-scholar');
  await expect(page).toHaveURL(url => url.searchParams.get('provider') === 'semantic-scholar');
  await noHorizontalOverflow(page, testInfo, 'mobile-s2-home');
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  const navSelector = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('combobox', { name: 'Search source', exact: true });
  await expect(navSelector).toBeVisible();
  await expect(navSelector).toHaveValue('semantic-scholar');
  await navSelector.selectOption('openalex');
  await expect(page.locator('main').getByRole('combobox', { name: 'Data source', exact: true })).toHaveValue('openalex');
  await noHorizontalOverflow(page, testInfo, 'mobile-source-navigation');
  await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
  await page.locator('main').getByRole('combobox', { name: 'Data source', exact: true }).selectOption('semantic-scholar');
  const query = S2_SAVED_PAPERS[0].id;
  diagnostics.expectedFailureUrls.add(`/api/search?q=${encodeURIComponent(query)}&page=1&provider=semantic-scholar`);
  await page.locator('main').getByRole('textbox', { name: 'Search academic papers' }).fill(query);
  await page.getByRole('button', { name: 'Build a graph', exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === '/search' && url.searchParams.get('provider') === 'semantic-scholar');
  await expect(page.getByRole('alert')).toContainText('Semantic Scholar unavailable');
  await expect(page.locator('main').getByRole('combobox', { name: 'Data source', exact: true })).toHaveValue('semantic-scholar');
  await noHorizontalOverflow(page, testInfo, 'mobile-s2-search');
  await screenshot(page, testInfo, 'mobile-s2-offline');
});

test('graph selection adds second and third origins, preserves them on reload and enforces the limit', async ({ page }) => {
  let graph = await openGraph(page);
  const originIds = [...graph.origins];
  for (let count = 2; count <= 3; count++) {
    const candidate = graph.nodes.find(paper => !originIds.includes(paper.id))!;
    await selectPaper(page, candidate);
    const pending = page.waitForResponse(response => response.url().includes('/api/graph?'));
    await details(page).getByRole('button', { name: 'Add origin', exact: true }).click();
    originIds.push(candidate.id);
    const response = await pending;
    expect(response.ok(), await response.text()).toBe(true);
    graph = await response.json();
    await expect(page).toHaveURL(url => url.pathname === `/graph/${originIds.join(',')}/graph`);
    await expect(page.locator('g.graph-node--origin')).toHaveCount(count);
    expect(graph.origins).toEqual(originIds);
  }
  await page.reload();
  await expect(page.locator('g.graph-node--origin')).toHaveCount(3);
  const other = graph.nodes.find(paper => !paper.isOrigin)!;
  await selectPaper(page, other);
  await expect(details(page).getByRole('button', { name: 'Add origin', exact: true })).toBeDisabled();
  await details(page).getByRole('link', { name: 'Open graph', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/graph/${other.id}/graph$`));
  await expect(page.locator('g.graph-node--origin')).toHaveCount(1);
  await expect(details(page).getByRole('heading', { name: other.title, exact: true })).toBeVisible();
});

test('library checkboxes build a real multi-origin graph and reject a fourth selection', async ({ page }) => {
  const graph = await openGraph(page);
  const papers = graph.nodes.slice(0, 4);
  for (const paper of papers) {
    await selectPaper(page, paper);
    await details(page).getByRole('button', { name: `Save ${paper.title}`, exact: true }).click();
  }
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: /^Library/ }).click();
  await expect(page.locator('.library-row')).toHaveCount(4);
  for (const paper of papers.slice(0, 3)) await page.getByRole('checkbox', { name: `Select ${paper.title} for combined graph`, exact: true }).check();
  await page.getByRole('checkbox', { name: `Select ${papers[3].title} for combined graph`, exact: true }).click();
  await expect(page.getByRole('checkbox', { name: `Select ${papers[3].title} for combined graph`, exact: true })).not.toBeChecked();
  await expect(page.locator('.toast')).toContainText('Select at most 3 origin papers.');
  await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(3);
  const link = page.getByRole('link', { name: 'Build combined graph (3)', exact: true });
  await expect(link).toHaveAttribute('href', `/graph/${papers.slice(0, 3).map(paper => paper.id).join(',')}/graph`);
  await link.click();
  await expect(page.locator('g.graph-node--origin')).toHaveCount(3);
  for (const paper of papers.slice(0, 3)) await expect(page.locator(`g[data-paper-id="${paper.id}"]`)).toHaveClass(/graph-node--origin/);
  await page.reload();
  await expect(page.locator('g.graph-node--origin')).toHaveCount(3);
});

test('invalid and unavailable origin IDs show accessible errors and allow recovery', async ({ page, diagnostics }, testInfo) => {
  for (const [id, status, message] of [
    ['not-a-work', 400, 'Use 1 to 3 distinct paper IDs'],
    ['W999999999999999', 404, 'not available in the offline collection'],
  ] as const) {
    diagnostics.expectedFailureUrls.add(`/api/graph?ids=${id}`);
    const pending = page.waitForResponse(response => response.url().includes('/api/graph?'));
    await page.goto(`/graph/${id}/graph`);
    expect((await pending).status()).toBe(status);
    const alert = page.getByRole('alert');
    await expect(alert).toContainText(message);
    await expect(alert.getByRole('heading')).toContainText('load this research');
    await expect(nodes(page)).toHaveCount(0);
    await screenshot(page, testInfo, `error-${status}`);
    await noHorizontalOverflow(page, testInfo, `error-${status}`);
    await alert.getByRole('link', { name: 'Try an example graph' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.example-card')).toHaveCount(3);
  }
  await page.goto('/this-page-does-not-exist');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await page.getByRole('link', { name: 'Return to search' }).click();
  await expect(page.locator('.example-card')).toHaveCount(3);
});

test('keyboard graph nodes select and re-origin; zoom, help and methodology are accessible', async ({ page }) => {
  const graph = await openGraph(page);
  const first = nodes(page).first();
  // Reach a node by real sequential keyboard navigation, not synthetic DOM clicks.
  await page.locator('.graph-summary button').focus();
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();
  for (const key of ['Enter', 'Space']) {
    await first.press(key);
    const id = await first.getAttribute('data-paper-id');
    await expect(page).toHaveURL(url => url.searchParams.get('selected') === id);
    await expect(first).toHaveAttribute('aria-pressed', 'true');
    const paper = graph.nodes.find(paper => paper.id === id)!;
    await expect(details(page).getByRole('heading', { name: paper.title, exact: true })).toBeVisible();
    await first.press('Tab');
    await expect(nodes(page).nth(1)).toBeFocused();
    await nodes(page).nth(1).press('Space');
    await expect(first).toHaveAttribute('aria-pressed', 'false');
    await nodes(page).nth(1).press('Shift+Tab');
  }
  const camera = page.locator('svg.graph-svg > g');
  const fitted = await camera.getAttribute('transform');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(camera).not.toHaveAttribute('transform', fitted!);
  await page.getByRole('button', { name: 'Fit all papers in view', exact: true }).click();
  await expect(camera).toHaveAttribute('transform', fitted!);
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await expect(camera).not.toHaveAttribute('transform', fitted!);
  await page.getByRole('button', { name: 'Fit all papers in view', exact: true }).click();
  const helpButton = page.getByRole('button', { name: 'How to read and navigate the graph' });
  await helpButton.focus();
  await page.keyboard.press('Enter');
  const help = page.getByRole('region', { name: 'How to read the graph', exact: true });
  await expect(helpButton).toHaveAttribute('aria-expanded', 'true');
  await expect(help).toContainText('not a citation tree');
  await expect(help).toContainText('Shift+Enter');
  await page.keyboard.press('Escape');
  await expect(help).not.toBeVisible();
  await expect(helpButton).toBeFocused();
  await helpButton.click();
  await help.getByRole('button', { name: 'Close help' }).click();
  await expect(helpButton).toBeFocused();
  const candidate = graph.nodes.find(paper => !paper.isOrigin)!;
  await page.locator(`g[data-paper-id="${candidate.id}"]`).press('Shift+Enter');
  await expect(page).toHaveURL(new RegExp(`/graph/${candidate.id}/graph$`));
  await expect(details(page).getByRole('heading', { name: candidate.title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Coverage & methodology', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Data & methodology' });
  await expect(dialog.getByRole('heading', { name: 'How similarity is calculated' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'How it works' }).click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.getByRole('heading', { name: 'How does it work?' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your library stays local' })).toBeVisible();
  await expect(page.locator('main')).toContainText('not on our server');
});

for (const viewport of [{ width: 390, height: 844 }, { width: 834, height: 1112 }]) {
  test(`responsive ${viewport.width}x${viewport.height}: every panel, table, dialog and library remains accessible without document overflow`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.locator('.example-card')).toHaveCount(3);
    await noHorizontalOverflow(page, testInfo, 'home');
    await screenshot(page, testInfo, 'home');
    const graph = await openGraph(page);
    await noHorizontalOverflow(page, testInfo, 'graph');
    await screenshot(page, testInfo, 'graph');
    const paper = graph.nodes.find(paper => !paper.isOrigin)!;
    const panels = page.getByRole('group', { name: 'Workspace panels' });
    if (viewport.width <= 1000) {
      await panels.getByRole('button', { name: /^Papers/ }).click();
      await expect(graphPapers(page)).toBeVisible();
      await noHorizontalOverflow(page, testInfo, 'papers');
      await graphPapers(page).getByRole('button').filter({ has: page.locator('strong', { hasText: paper.title }) }).click();
    } else await selectPaper(page, paper);
    await expect(details(page).getByRole('heading', { name: paper.title, exact: true })).toBeVisible();
    await noHorizontalOverflow(page, testInfo, 'details');
    await screenshot(page, testInfo, 'details');
    await details(page).getByRole('button', { name: `Save ${paper.title}`, exact: true }).click();
    if (viewport.width <= 1000) {
      await panels.getByRole('button', { name: 'Graph', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Paper similarity graph', exact: true })).toBeVisible();
      await panels.getByRole('button', { name: 'Details', exact: true }).click();
      await expect(details(page)).toBeVisible();
    }
    for (const [view, label] of [['prior', /^Prior/], ['derivative', /^Derivative/], ['list', /^List/]] as const) {
      await views(page).getByRole('link', { name: label }).click();
      await expect(page.locator('tbody tr').first()).toBeVisible();
      await page.getByRole('columnheader').getByRole('button', { name: 'Year', exact: true }).click();
      await noHorizontalOverflow(page, testInfo, view);
      const title = await page.locator('.table-title').first().textContent();
      await page.locator('.table-title').first().click();
      await expect(details(page).getByRole('heading', { name: title!, exact: true })).toBeVisible();
      if (viewport.width <= 1000) {
        await panels.getByRole('button', { name: 'Results', exact: true }).click();
        await expect(page.locator('tbody tr').first()).toBeVisible();
      }
    }
    await views(page).getByRole('link', { name: 'Graph', exact: true }).click();
    await expect(nodes(page)).toHaveCount(40);
    for (const [name, title] of [['Filter papers', 'Filter graph papers'], ['Export graph', 'Export your research'], ['Coverage & methodology', 'Data & methodology']]) {
      const button = page.getByRole('button', { name, exact: true });
      await button.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: title, exact: true });
      await focusStaysInDialog(page, dialog);
      await noHorizontalOverflow(page, testInfo, title);
      await screenshot(page, testInfo, title.replaceAll(' ', '-'));
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await restoredFocus(page, button, testInfo, title);
    }
    await page.getByRole('button', { name: 'How to read and navigate the graph' }).click();
    await expect(page.getByRole('region', { name: 'How to read the graph', exact: true })).toBeVisible();
    await noHorizontalOverflow(page, testInfo, 'help');
    await screenshot(page, testInfo, 'help');
    await page.keyboard.press('Escape');
    if (viewport.width <= 700) {
      const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
      await menu.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: 'Close navigation', exact: true })).toHaveAttribute('aria-expanded', 'true');
    }
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: /^Library/ }).click();
    await expect(page.getByRole('heading', { name: paper.title, exact: true })).toBeVisible();
    await noHorizontalOverflow(page, testInfo, 'library');
    await screenshot(page, testInfo, 'library');
    await page.getByRole('link', { name: 'Open Papers home', exact: true }).click();
    await page.locator('main').getByRole('textbox', { name: 'Search academic papers' }).fill('learning');
    await page.getByRole('button', { name: 'Build a graph', exact: true }).click();
    await expect(page.locator('.paper-card')).toHaveCount(20);
    await noHorizontalOverflow(page, testInfo, 'search');
    await page.getByRole('navigation', { name: 'Search result pages' }).getByRole('link', { name: 'Next', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Search result pages' })).toContainText('Page 2');
    await noHorizontalOverflow(page, testInfo, 'search-page-2');
    if (viewport.width <= 700) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'How it works' }).click();
    await expect(page.getByRole('heading', { name: 'How does it work?' })).toBeVisible();
    await noHorizontalOverflow(page, testInfo, 'about');
  });
}
