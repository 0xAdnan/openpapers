import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { type lookup } from 'node:dns';
import { type request } from 'node:https';
import test from 'node:test';
import { PersistentCache } from './cache.ts';
import { OpenAlexProvider, normalizeWork, type OpenAlexWork } from './openalex.ts';
import { PaperService } from './service.ts';
import { PublisherReferences } from './publisher-references.ts';
import { PdfReferences, extractPdfReferences, pdfText, resolvePdfReferences } from './pdf-references.ts';
import { downloadDocument, downloadPdf, MAX_PDF_BYTES, pdfUrl, publicAddress } from './pdf-download.ts';

const origin: OpenAlexWork = { id: 'https://openalex.org/W99', doi: 'https://doi.org/10.1234/origin',
  display_name: 'Synthetic PDF repair paper', publication_year: 2026, referenced_works: [], related_works: [],
  best_oa_location: { pdf_url: 'https://publisher.example/paper.pdf' } };
const text = `Synthetic PDF repair paper\nArticle DOI: 10.1234/origin\nBody cites 10.1234/body, not bibliography evidence.\n\f\nREFERENCES\n[1] A. Researcher, "Synthetic cited study," 2020, doi: 10.1234/ref.\n[2] B. Scholar, "Synthetic title-only study," 2021.\n[3] C. Scholar, "Ambiguous cited study," 2020, doi: 10.1234/ambiguous.\n[4] D. Scholar, "Mismatched DOI title," 2020, doi: 10.1234/wrong.\n[5] A. Researcher, "Synthetic ambiguous title," 2021.\n[6] A. Researcher, "Synthetic wrong author," 2021.\n[7] A. Researcher, "Synthetic wrong year," 2021.\n[8] "Unattributed title is not enough," 2021.\n`;
const ref = { id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1234/ref', display_name: 'Synthetic cited study', publication_year: 2020 };

async function setup(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'pdf-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = new PersistentCache(directory);
  let downloads = 0;
  const pdf = new PdfReferences(cache, { download: async () => { downloads++; return new Uint8Array(Buffer.from('%PDF-synthetic')); }, extract: async () => text });
  const publisher = new PublisherReferences(cache, { fetch: async () => Response.json({ message: { DOI: '10.1234/origin', title: [origin.display_name], reference: [] } }) });
  const provider = new OpenAlexProvider({ cache, fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname === '/works/W99') return Response.json(origin);
    const filter = url.searchParams.get('filter') ?? '';
    if (filter.startsWith('doi:')) return Response.json({ results: [ref,
      { ...ref, id: 'https://openalex.org/W3', doi: 'https://doi.org/10.1234/ambiguous', display_name: 'Ambiguous cited study' },
      { ...ref, id: 'https://openalex.org/W4', doi: 'https://doi.org/10.1234/ambiguous', display_name: 'Ambiguous cited study' },
      { ...ref, id: 'https://openalex.org/W5', doi: 'https://doi.org/10.1234/wrong', display_name: 'Unrelated publication' },
    ], meta: { count: 4 } });
    const search = /^title.search:(.*),publication_year:/.exec(filter)?.[1];
    if (search) {
      const work = { id: 'https://openalex.org/W2', display_name: search, publication_year: search.includes('wrong year') ? 2022 : 2021,
        authorships: [{ author: { display_name: search.includes('wrong author') ? 'Another Author'
          : search.includes('title only study') ? 'Bob Scholar' : 'Alice Researcher' } }] };
      const results = search.includes('ambiguous title') ? [work, { ...work, id: 'https://openalex.org/W6' }] : [work];
      return Response.json({ results, meta: { count: results.length } });
    }
    return Response.json({ results: [], meta: { count: 0 } });
  } });
  return { cache, provider, publisher, pdf, downloads: () => downloads, directory };
}

test('PDF bibliography extraction ignores body DOI mentions and requires sufficient title evidence', () => {
  const refs = extractPdfReferences(text);
  assert.equal(refs.length, 7);
  assert.equal(refs[0].doi, '10.1234/ref');
  assert.equal(refs[1].author, 'Scholar');
  assert.ok(!refs.some(ref => ref.doi === '10.1234/body'));
  assert.deepEqual(extractPdfReferences('Body 10.1234/body without a reference heading'), []);
  assert.ok(!extractPdfReferences(`${text}\nAPPENDIX\n[9] Supplemental DOI 10.1234/not-cited.`).some(ref => ref.doi === '10.1234/not-cited'));
});

test('PDF matching rejects ambiguous DOI/title identities and DOI-title/author/year conflicts', async t => {
  const f = await setup(t);
  const result = await resolvePdfReferences(f.provider, extractPdfReferences(text), 'W99', AbortSignal.timeout(10000));
  assert.deepEqual(result.works.map(work => work.id).sort(), ['https://openalex.org/W1', 'https://openalex.org/W2']);
  assert.equal(result.doiMatches, 1);
  assert.equal(result.titleMatches, 1);
});

test('a title lookup failure retains verified DOI references and labels partial recovery', async t => {
  const f = await setup(t);
  const provider = new OpenAlexProvider({ cache: f.cache, fetch: async input => {
    if (new URL(String(input)).searchParams.get('filter')?.startsWith('doi:')) return Response.json({ results: [ref], meta: { count: 1 } });
    return new Response('', { status: 503 });
  } });
  const result = await resolvePdfReferences(provider, extractPdfReferences(text), 'W99', AbortSignal.timeout(5000));
  assert.deepEqual(result.works, [ref]);
  assert.equal(result.incomplete, true);
});

test('empty Crossref metadata falls back to PDF bibliography and upgrades old empty recovered pools', async t => {
  const f = await setup(t);
  await f.cache.set('pool:W99', { origin: 'W99', papers: [normalizeWork(origin)], source: 'cache',
    fetchedAt: new Date().toISOString(), coverage: 'Legacy empty Crossref recovery', referenceRecovery: 'crossref-v1' });
  const service = new PaperService(f.cache, false, f.provider, undefined, f.publisher, f.pdf);
  const graph = await service.graph(['W99']);
  assert.deepEqual(graph.nodes.find(p => p.isOrigin)!.references.sort(), ['W1', 'W2']);
  assert.ok(graph.edges.length >= 2);
  assert.match(graph.meta.coverage, /PDF bibliography.*1 exact DOI.*1 unique title\/year\/author/);
  assert.equal(f.downloads(), 1);
  await service.graph(['W99']);
  await new PaperService(new PersistentCache(f.directory), false, f.provider, undefined, f.publisher, f.pdf).graph(['W99']);
  assert.equal(f.downloads(), 1);
  assert.deepEqual(origin.referenced_works, [], 'upstream records remain unmodified');
  const pool = await f.cache.get<{ referenceRecovery: string }>('pool:W99');
  assert.equal(pool?.value.referenceRecovery, 'bibliography-v2');
});

test('PDF lookup verifies origin DOI and title, deduplicates work, caches and cancels', async t => {
  const f = await setup(t);
  await Promise.all([f.pdf.lookup(origin), f.pdf.lookup(origin)]);
  assert.equal(f.downloads(), 1);
  for (const bad of [text.replace('10.1234/origin', '10.1234/other'), text.replace('Synthetic PDF repair paper', 'Other paper')]) {
    const invalid = new PdfReferences(f.cache, { extract: async () => bad, download: async () => new Uint8Array([1]) });
    assert.equal(await invalid.lookup({ ...origin, best_oa_location: { pdf_url: `https://publisher.example/${bad.length}.pdf` } }), undefined);
  }
  const slow = new PdfReferences(f.cache, { timeoutMs: 20, download: async (_url, signal) => {
    await delay(1000, undefined, { signal });
    throw new Error('unreachable');
  } });
  assert.equal(await slow.lookup({ ...origin, best_oa_location: { pdf_url: 'https://publisher.example/slow.pdf' } }), undefined);
  await assert.rejects(f.pdf.lookup(origin, AbortSignal.abort(new Error('User cancelled'))), /User cancelled/);
});

test('offline graph recovery never downloads a provider PDF, and failed PDF recovery has a short TTL', async t => {
  const f = await setup(t);
  await f.cache.set('pool:W99', { origin: 'W99', papers: [normalizeWork(origin)], source: 'cache',
    fetchedAt: new Date().toISOString(), coverage: 'Empty indexed pool', referenceRecovery: 'crossref-v1' });
  const offline = new PaperService(f.cache, true, f.provider, undefined, f.publisher, f.pdf);
  assert.equal((await offline.graph(['W99'])).nodes.length, 1);
  assert.equal(f.downloads(), 0);
  const bad = new PdfReferences(f.cache, { download: async () => { throw new Error('Unreachable PDF'); } });
  const failed = await new PaperService(f.cache, false, f.provider, undefined, f.publisher, bad).graph(['W99']);
  assert.equal(failed.nodes.length, 1);
  assert.match(failed.meta.coverage, /PDF reference recovery unavailable/);
  assert.ok((await f.cache.get('pool:W99'))!.expiresAt <= Date.now() + 31000);
});

test('PDF download blocks non-public addresses, mixed DNS, credentials, redirects and excessive bodies', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1']) assert.equal(publicAddress(address), false);
  assert.equal(publicAddress('93.184.216.34'), true);
  for (const url of ['http://publisher.example/a.pdf', 'https://127.0.0.1/a', 'https://[::ffff:127.0.0.1]/a', 'https://user:pass@publisher.example/a', 'https://publisher.example:444/a', 'https://localhost/a']) assert.equal(pdfUrl(url), undefined);
  const signal = AbortSignal.timeout(1000);
  const url = new URL('https://publisher.example/paper.pdf');
  let connected = false;
  const dns = ((_host: string, _options: unknown, callback: Function) => callback(null, [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }])) as unknown as typeof lookup;
  await assert.rejects(downloadPdf(url, signal, { lookup: dns, request: (() => { connected = true; }) as unknown as typeof request }), /Non-public/);
  assert.equal(connected, false);
  const publicDns = ((_host: string, _options: unknown, callback: Function) => callback(null, [{ address: '93.184.216.34', family: 4 }])) as unknown as typeof lookup;
  for (const scenario of ['redirect', 'oversize', 'header-size', 'mime', 'compressed', 'magic', 'valid']) {
    const transport = ((_url: URL, options: { lookup: Function; agent: boolean }, callback: Function) => {
      options.lookup('publisher.example', {}, (error: unknown, address: string) => { assert.equal(error, null); assert.equal(address, '93.184.216.34'); });
      assert.equal(options.agent, false);
      const req = new EventEmitter() as EventEmitter & { end(): void; destroy(error: Error): void };
      req.destroy = error => { if (error) req.emit('error', error); };
      req.end = () => {
        const response = new EventEmitter() as EventEmitter & { statusCode: number; headers: object; destroy(): void };
        response.statusCode = scenario === 'redirect' ? 302 : 200;
        response.headers = { 'content-type': scenario === 'mime' ? 'text/html' : 'application/pdf',
          ...(scenario === 'header-size' ? { 'content-length': String(MAX_PDF_BYTES + 1) } : {}),
          ...(scenario === 'compressed' ? { 'content-encoding': 'gzip' } : {}) };
        response.destroy = () => {};
        callback(response);
        response.emit('data', scenario === 'oversize' ? Buffer.alloc(MAX_PDF_BYTES + 1) : Buffer.from(scenario === 'magic' ? 'not pdf' : '%PDF-valid'));
        response.emit('end');
      };
      return req;
    }) as unknown as typeof request;
    const operation = downloadPdf(url, signal, { lookup: publicDns, request: transport });
    if (scenario === 'valid') assert.equal(Buffer.from(await operation).toString(), '%PDF-valid'); else await assert.rejects(operation);
  }
});

function syntheticPdf(): Uint8Array {
  // Minimal, generated test document. No publisher PDF is bundled.
  const stream = 'BT /F1 12 Tf 20 180 Td (Synthetic PDF text) Tj 0 -20 Td (REFERENCES) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let body = '%PDF-1.4\n'; const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(body.length); body += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = body.length;
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Uint8Array(Buffer.from(body));
}

test('document cancellation rejects even when a stalled transport emits no error or response', async () => {
  const dns = ((_host: string, _options: unknown, callback: Function) => callback(null, [{ address: '93.184.216.34', family: 4 }])) as unknown as typeof lookup;
  let destroy = 0;
  const transport = (() => {
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
    req.end = () => {}; req.destroy = () => { destroy++; }; return req;
  }) as unknown as typeof request;
  const controller = new AbortController();
  const pending = downloadDocument(new URL('https://publisher.example/stalled'), controller.signal, { lookup: dns, request: transport });
  const rejected = assert.rejects(pending, /Navigation/);
  await delay(5); controller.abort(new Error('Navigation')); await rejected;
  assert.equal(destroy, 1);
});

test('production PDF worker extracts text from PDF bytes without a shell and terminates on cancellation', async () => {
  assert.match(await pdfText(syntheticPdf(), AbortSignal.timeout(5000)), /Synthetic PDF text\s+REFERENCES/);
  await assert.rejects(pdfText(syntheticPdf(), AbortSignal.timeout(1)));
});
