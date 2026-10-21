import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { normalizeText } from '../shared/fuzzy.ts';
import type { DataMeta } from '../shared/types.ts';
import { PersistentCache } from './cache.ts';
import { downloadPdf, pdfUrl } from './pdf-download.ts';
import { OpenAlexProvider, SELECT, workId, type OpenAlexWork, type WorksPage } from './openalex.ts';
import { referenceDoi } from './publisher-references.ts';

export const referenceIdentity = (text: string) => normalizeText(text.replace(/\u00ad/g, '').replace(/(\p{L})-\s*\n\s*(?=\p{L})/gu, '$1'))
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const TTL = 6 * 60 * 60 * 1000;
const ReferenceSchema = z.object({ doi: z.string().optional(), title: z.string().max(2000).optional(),
  year: z.number().int().min(1900).max(2100).optional(), author: z.string().max(300).optional(), excerpt: z.string().max(4000) });
const BibliographySchema = z.object({ originDoi: z.string(), originTitle: z.string(), url: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), fetchedAt: z.string().datetime(), references: z.array(ReferenceSchema).max(50) });
export type PdfReference = z.infer<typeof ReferenceSchema>;

export async function resolvePdfReferences(provider: OpenAlexProvider, references: PdfReference[], origin: string, signal: AbortSignal) {
  const works = new Map<string, OpenAlexWork>();
  const metadata: DataMeta[] = [];
  let doiMatches = 0, titleMatches = 0;
  const dois = [...new Set(references.flatMap(ref => ref.doi ? [ref.doi] : []))];
  if (dois.length) {
    const page = await provider.request<WorksPage>('/works', { filter: `doi:${dois.map(doi => `https://doi.org/${doi}`).join('|')}`,
      per_page: '100', select: SELECT }, signal);
    metadata.push(provider.metadata(page));
    for (const doi of dois) {
      const matches = page.results.filter(work => referenceDoi(work.doi) === doi && workId(work.id) !== origin);
      if (new Set(matches.map(work => workId(work.id))).size !== 1) continue;
      const work = matches[0];
      // A mistyped DOI pointing at another publication must not create a citation.
      const entries = references.filter(ref => ref.doi === doi);
      if (entries.some(ref => ref.title && referenceIdentity(ref.title) !== referenceIdentity(work.display_name ?? '') ||
          ref.year && ref.year !== work.publication_year)) continue;
      works.set(workId(work.id)!, work); doiMatches++;
    }
  }
  const titles = references.filter(ref => !ref.doi && ref.title && ref.year && ref.author).slice(0, 6);
  let next = 0;
  const checks = await Promise.allSettled(Array.from({ length: Math.min(2, titles.length) }, async () => {
    while (next < titles.length) {
      const ref = titles[next++];
      const page = await provider.request<WorksPage>('/works', {
        filter: `title.search:${referenceIdentity(ref.title!)},publication_year:${ref.year}`, per_page: '100', select: SELECT }, signal);
      metadata.push(provider.metadata(page));
      // More than one page of candidates cannot prove uniqueness; don't guess from rank.
      if (page.meta.count > page.results.length) continue;
      const matches = page.results.filter(work => workId(work.id) !== origin && work.publication_year === ref.year &&
        referenceIdentity(work.display_name ?? '') === referenceIdentity(ref.title!) &&
        work.authorships?.some(a => referenceIdentity(a.author?.display_name ?? '').split(' ').includes(referenceIdentity(ref.author!))));
      if (new Set(matches.map(work => workId(work.id))).size !== 1) continue;
      works.set(workId(matches[0].id)!, matches[0]); titleMatches++;
    }
  }));
  const incomplete = checks.some(check => check.status === 'rejected') || titles.length < references.filter(ref => !ref.doi && ref.title && ref.year && ref.author).length;
  return { works: [...works.values()], doiMatches, titleMatches, metadata, incomplete };
}

/** Only bibliography entries, never DOI strings or quoted titles in body text. */
export function extractPdfReferences(text: string): PdfReference[] {
  const headings = [...text.matchAll(/^\s*(?:\d+[.\s]+)?(?:references|bibliography|literature cited)\s*$/gim)];
  const heading = headings.at(-1);
  if (!heading) return [];
  const bibliography = text.slice(heading.index! + heading[0].length).replace(/\f/g, '\n')
    .split(/^\s*(?:appendix(?:\s+[a-z0-9])?|appendices|supplementary material|acknowledg(?:e)?ments)\s*$/im)[0];
  const numbered = [...bibliography.matchAll(/^\s*(?:\[(\d{1,3})\]|(\d{1,3})\.)\s+/gm)];
  // Unnumbered entries are supported only when separated by a blank line.
  const entries = numbered.length ? numbered.map((marker, i) => bibliography.slice(marker.index! + marker[0].length, numbered[i + 1]?.index))
    : bibliography.split(/\n\s*\n/);
  return entries.slice(0, 50).flatMap(entry => {
    const excerpt = entry.replace(/\s+/g, ' ').trim().slice(0, 4000);
    const raw = /\b10\.\d{4,9}\/[^\s<>"“”]+/i.exec(excerpt)?.[0].replace(/[.,;:]+$/, '');
    const doi = referenceDoi(raw);
    const quoted = /["“]([^"“”]{8,2000})["”]/.exec(excerpt);
    const title = quoted?.[1].replace(/[,.;:]+$/, '').trim();
    const years = excerpt.replace(/https?:\/\/\S+|10\.\d{4,9}\/\S+/gi, '').match(/\b(?:19|20)\d{2}\b/g);
    const year = years?.length ? Number(years.at(-1)) : undefined;
    const prefix = quoted ? excerpt.slice(0, quoted.index).trim().replace(/[,\s]+$/, '') : '';
    const firstAuthor = prefix.split(/,|\band\b|&/i)[0];
    const author = firstAuthor?.match(/\p{L}[\p{L}'’-]{1,}/gu)?.filter(word => !['et', 'al'].includes(word.toLowerCase())).at(-1);
    if (!doi && !(title && year && author)) return [];
    return [{ doi, title, year, author, excerpt }];
  });
}

export async function pdfText(data: Uint8Array, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const worker = new Worker(new URL('./pdf-text-worker.mjs', import.meta.url), { workerData: { data },
    resourceLimits: { maxOldGenerationSizeMb: 96, stackSizeMb: 4 }, execArgv: [] });
  try {
    return await new Promise<string>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      const finish = (error?: Error, text?: string) => {
        signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(text!);
      };
      worker.once('message', message => typeof message?.text === 'string' && message.text.length <= 500000
        ? finish(undefined, message.text) : finish(new Error('PDF text unavailable')));
      worker.once('error', error => finish(error));
      worker.once('exit', () => finish(new Error('PDF worker exited')));
    });
  } finally { await worker.terminate(); }
}

export class PdfReferences {
  private active = 0;
  private calls = 0;
  private day = '';
  constructor(private cache: PersistentCache, private options: {
    download?: typeof downloadPdf; extract?: typeof pdfText; timeoutMs?: number;
  } = {}) {}

  async lookup(origin: OpenAlexWork, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const doi = referenceDoi(origin.doi), title = referenceIdentity(origin.display_name ?? '');
    const url = pdfUrl(origin.best_oa_location?.pdf_url ?? origin.primary_location?.pdf_url);
    if (!doi || !title || title === 'untitled work' || !url) return;
    const key = `pdf:references:v1:${createHash('sha256').update(JSON.stringify([doi, title, url.href])).digest('hex')}`;
    const entry = await this.cache.get<unknown>(key);
    signal?.throwIfAborted();
    if (entry?.value === null) return;
    const stored = BibliographySchema.safeParse(entry?.value);
    if (stored.success && stored.data.originDoi === doi && stored.data.originTitle === title && stored.data.url === url.href &&
        Date.parse(stored.data.fetchedAt) + TTL > Date.now() && stored.data.references.every(ref => !ref.doi || referenceDoi(ref.doi) === ref.doi)) return { ...stored.data, source: 'cache' as const };
    return this.cache.deduplicate(key, async sharedSignal => {
      const deadline = AbortSignal.any([sharedSignal, AbortSignal.timeout(this.options.timeoutMs ?? 8000)]);
      const today = new Date().toISOString().slice(0, 10);
      if (today !== this.day) { this.day = today; this.calls = 0; }
      if (this.active >= 2 || this.calls >= 50) return;
      this.active++; this.calls++;
      try {
        const data = await (this.options.download ?? downloadPdf)(url, deadline);
        const text = await (this.options.extract ?? pdfText)(data, deadline);
        deadline.throwIfAborted();
        const front = text.slice(0, text.indexOf('\f') >= 0 ? text.indexOf('\f') : Math.min(12000, text.length));
        const frontDois = front.match(/\b10\.\d{4,9}\/[^\s<>"“”]+/gi)?.map(value => referenceDoi(value.replace(/[.,;:]+$/, ''))) ?? [];
        if (!referenceIdentity(front).includes(title) || !frontDois.includes(doi)) throw new Error('PDF origin identity mismatch');
        const result = BibliographySchema.parse({ originDoi: doi, originTitle: title, url: url.href,
          sha256: createHash('sha256').update(data).digest('hex'), fetchedAt: new Date().toISOString(),
          references: extractPdfReferences(text).filter(ref => ref.doi !== doi) });
        await this.cache.set(key, result, TTL);
        return { ...result, source: 'live' as const };
      } catch {
        sharedSignal.throwIfAborted();
        await this.cache.set(key, null, 30000);
        return;
      } finally { this.active--; }
    }, signal);
  }
}
