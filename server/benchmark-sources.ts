import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { z } from 'zod';
import type { Paper } from '../shared/types.ts';
import type { PaperBenchmarksResponse } from '../shared/benchmarks.ts';
import { discoverBenchmarks, mergeBenchmarks } from '../shared/benchmark-discovery.ts';
import { PersistentCache } from './cache.ts';
import { downloadDocument, downloadPdf, pdfUrl } from './pdf-download.ts';
import { pdfText, referenceIdentity } from './pdf-references.ts';
import { referenceDoi } from './publisher-references.ts';

const TTL = 6 * 3600000;
const limitations = 'Source-backed candidates, not exhaustive benchmark detection. Inaccessible, scanned, long, or unusually formatted papers and unlinked artifacts can leave gaps. Evaluation suites may overlap; names and links are not inferred from a catalog. Baselines and scores are not extracted.';
type Source = PaperBenchmarksResponse['coverage']['discovery']['sources'][number];
const DocumentSchema = z.object({ text: z.string().max(500000), fetchedAt: z.string().datetime(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const surname = (name: string) => referenceIdentity(name.includes(',') ? name.split(',')[0] : name.split(' ').at(-1) ?? '');
const artifactTitle = (title: string) => referenceIdentity(title.replace(/\s*(?:[—–:-]\s*)?(?:replication package|research artifact|artifact|supplementary material|dataset|software)\s*$/i, ''));
const safe = (value: unknown) => pdfUrl(typeof value === 'string' ? value.replace(/#.*$/, '') : value);

/** A search hit is not identity: require exact title + an author, or an explicit DOI supplement relation. */
export function verifiedArtifact(record: unknown, paper: Paper): boolean {
  const parsed = ArtifactSchema.safeParse(record);
  if (!parsed.success) return false;
  const a = parsed.data.attributes;
  const related = a.relatedIdentifiers.some(r => ['IsSupplementTo', 'IsPartOf', 'IsIdenticalTo'].includes(r.relationType) &&
    r.relatedIdentifierType === 'DOI' && referenceDoi(r.relatedIdentifier) === referenceDoi(paper.doi) && !!referenceDoi(paper.doi));
  const authors = new Set(paper.authors.map(surname).filter(name => name.length > 1));
  return related || a.titles.some(t => artifactTitle(t.title) === referenceIdentity(paper.title)) &&
    a.creators.some(c => authors.has(surname(c.familyName ?? c.name)));
}

const ArtifactSchema = z.object({ id: z.string().max(200), attributes: z.object({
  titles: z.array(z.object({ title: z.string().max(2000) })).max(20),
  creators: z.array(z.object({ name: z.string().max(500).default(''), familyName: z.string().max(300).optional() })).max(100),
  descriptions: z.array(z.object({ description: z.string().max(200000) })).max(20).default([]),
  relatedIdentifiers: z.array(z.object({ relationType: z.string().max(100), relatedIdentifierType: z.string().max(100), relatedIdentifier: z.string().max(2000) })).max(100).default([]),
  url: z.string().max(2000).nullable().optional(), updated: z.string().optional(),
}) });

function plainText(html: string) {
  const $ = load(html); $('script,style,nav,footer').remove();
  $('p,div,li,h1,h2,h3,h4,br').each((_i, el) => { $(el).append('\n\n'); });
  return $.root().text();
}

export function documentLinks(text: string, base: string): URL[] {
  const candidates = [...text.matchAll(/https:\/\/[^\s<>"'\])]+|\]\(([^\s)]+)\)/g)].map(m => m[1] ?? m[0]);
  if (/<a\b|<link\b/i.test(text)) {
    const $ = load(text); $('a[href],link[href]').each((_i, el) => { candidates.push($(el).attr('href')!); });
  }
  return [...new Set(candidates.map(value => {
    try { return new URL(value.replace(/[.,;]+$/, ''), base).href; } catch { return ''; }
  }))].flatMap(value => { const url = safe(value); return url ? [url] : []; }).slice(0, 50);
}

/** Bounded, read-only source retrieval. No repository cloning, archive extraction, credentials, or code execution. */
export class BenchmarkSources {
  private active = 0;
  private downloads = 0;
  private day = '';
  constructor(private cache: PersistentCache, private options: {
    download?: typeof downloadDocument; downloadPdf?: typeof downloadPdf; extract?: typeof pdfText;
  } = {}) {}

  private async document(url: URL, signal: AbortSignal, pdf = false) {
    const key = `benchmark-document:v1:${createHash('sha256').update(`${pdf}:${url.href}`).digest('hex')}`;
    const entry = await this.cache.get<unknown>(key);
    signal.throwIfAborted();
    if (entry?.value === null) throw new Error('Source temporarily unavailable');
    const stored = DocumentSchema.safeParse(entry?.value);
    if (stored.success && Date.parse(stored.data.fetchedAt) + TTL > Date.now()) return stored.data;
    return this.cache.deduplicate(key, async sharedSignal => {
      const today = new Date().toISOString().slice(0, 10);
      if (this.day !== today) { this.day = today; this.downloads = 0; }
      if (this.downloads >= 150) throw new Error('Source download budget reached');
      this.downloads++;
      const deadline = AbortSignal.any([sharedSignal, AbortSignal.timeout(pdf ? 8000 : 5000)]);
      try {
        const bytes = pdf ? await (this.options.downloadPdf ?? downloadPdf)(url, deadline)
          : await (this.options.download ?? downloadDocument)(url, deadline);
        const text = pdf ? await (this.options.extract ?? pdfText)(bytes, deadline) : Buffer.from(bytes).toString('utf8');
        deadline.throwIfAborted();
        const doc = DocumentSchema.parse({ text, fetchedAt: new Date().toISOString(), sha256: createHash('sha256').update(bytes).digest('hex') });
        await this.cache.set(key, doc, TTL);
        return doc;
      } catch (error) {
        sharedSignal.throwIfAborted();
        await this.cache.set(key, null, 30000);
        throw error;
      }
    }, signal);
  }

  async discover(paper: Paper, signal: AbortSignal, offline = false): Promise<Pick<PaperBenchmarksResponse, 'benchmarks' | 'coverage'>> {
    const fields: PaperBenchmarksResponse['coverage']['fields'] = paper.abstract ? ['title', 'abstract'] : ['title'];
    const benchmarks = mergeBenchmarks([
      ...discoverBenchmarks({ kind: 'title', text: paper.title, url: paper.url }),
      ...discoverBenchmarks({ kind: 'abstract', text: paper.abstract, url: paper.url }),
    ]);
    const sources: Source[] = [];
    const result = (): Pick<PaperBenchmarksResponse, 'benchmarks' | 'coverage'> => ({ benchmarks: mergeBenchmarks(benchmarks),
      coverage: { fields, discovery: { status: fields.includes('fulltext') ? sources.some(s => s.status !== 'read') ? 'partial' : 'complete'
        : fields.includes('artifact') ? 'partial' : 'unavailable', sources, limitations: offline ? `Offline mode: available metadata and cached discovery only. ${limitations}` : limitations } } });
    signal.throwIfAborted();
    if (offline || this.active >= 2) return result();
    this.active++;
    try {
      const read = async (url: URL, kind: Source['kind'], task: (doc: z.infer<typeof DocumentSchema>) => void | Promise<void>, pdf = false) => {
        if (signal.aborted || sources.length >= 20) return;
        const source: Source = { kind, url: url.href, status: 'unavailable' }; sources.push(source);
        try {
          const doc = await this.document(url, signal, pdf);
          source.status = 'rejected';
          await task(doc);
          source.status = 'read'; source.fetchedAt = doc.fetchedAt; source.sha256 = doc.sha256;
        } catch { /* retain candidates from other sources; caller cancellation is handled by the service */ }
      };
      const pdfs = new Map<string, { url: URL; artifact: boolean; availabilityUrl?: string }>();
      const primary = safe(paper.pdfUrl); if (primary) pdfs.set(primary.href, { url: primary, artifact: false });
      const doi = referenceDoi(paper.doi);
      const repos = new Map<string, URL>();
      const rememberRepo = (url: URL) => {
        if (url.hostname !== 'github.com') return;
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length >= 2 && parts.slice(0, 2).every(part => /^[\w.-]+$/.test(part))) repos.set(parts.slice(0, 2).join('/'), url);
      };
      // Both metadata providers are fixed public endpoints; search expressions are escaped literal titles.
      await Promise.allSettled([
        doi ? read(new URL(`https://api.crossref.org/works/${encodeURIComponent(doi)}`), 'metadata', doc => {
          const parsed = z.object({ message: z.object({ DOI: z.string(), title: z.array(z.string()),
            link: z.array(z.object({ URL: z.string(), 'content-type': z.string().optional() })).default([]) }) }).parse(JSON.parse(doc.text));
          const m = parsed.message;
          if (referenceDoi(m.DOI) !== doi || !m.title.some(title => referenceIdentity(title) === referenceIdentity(paper.title))) throw new Error('Paper metadata mismatch');
          for (const link of m.link) { const url = safe(link.URL); if (url && (link['content-type'] === 'application/pdf' || /\/pdf\b|\.pdf$/i.test(url.pathname))) pdfs.set(url.href, { url, artifact: false }); }
        }) : Promise.resolve(),
        read((() => { const url = new URL('https://api.datacite.org/dois');
          url.searchParams.set('query', `titles.title:"${paper.title.replace(/["\\]/g, '\\$&')}"`); url.searchParams.set('page[size]', '5'); return url; })(), 'metadata', doc => {
          const parsed = z.object({ data: z.array(z.unknown()).max(5) }).parse(JSON.parse(doc.text));
          const verified = parsed.data.filter(record => verifiedArtifact(record, paper)).map(record => ArtifactSchema.parse(record))
            .filter(record => referenceDoi(record.id))
            .sort((a, b) => {
              const version = (record: z.infer<typeof ArtifactSchema>) => record.attributes.relatedIdentifiers.some(rel => rel.relationType === 'IsVersionOf');
              return Number(version(b)) - Number(version(a)) || b.id.localeCompare(a.id, undefined, { numeric: true });
            });
          for (const record of verified.slice(0, 2)) {
            const sourceUrl = `https://doi.org/${encodeURI(record.id)}`;
            const description = record.attributes.descriptions.map(d => plainText(d.description)).join('\n\n');
            benchmarks.push(...discoverBenchmarks({ kind: 'artifact', text: description, url: sourceUrl, availabilityUrl: sourceUrl }));
            if (!fields.includes('artifact')) fields.push('artifact');
            sources.push({ kind: 'artifact', url: sourceUrl, status: 'read', fetchedAt: doc.fetchedAt, sha256: doc.sha256 });
            for (const rel of record.attributes.relatedIdentifiers) if (rel.relatedIdentifierType === 'URL' && ['IsSupplementedBy', 'IsIdenticalTo', 'HasPart'].includes(rel.relationType)) {
              const url = safe(rel.relatedIdentifier); if (url) rememberRepo(url);
            }
          }
        }),
      ]);
      for (const [repo] of [...repos].slice(0, 2)) {
        let verifiedReadme = false;
        await read(new URL(`https://api.github.com/repos/${repo}/readme`), 'artifact', doc => {
          const json = z.object({ content: z.string().max(1400000), encoding: z.literal('base64'), download_url: z.string().url() }).parse(JSON.parse(doc.text));
          const markdown = Buffer.from(json.content, 'base64').toString('utf8');
          if (markdown.length > 500000 || !referenceIdentity(markdown).includes(referenceIdentity(paper.title))) throw new Error('Artifact README identity mismatch');
          verifiedReadme = true;
          const url = `https://github.com/${repo}`;
          benchmarks.push(...discoverBenchmarks({ kind: 'artifact', text: markdown, url, availabilityUrl: url }));
          const raw = safe(json.download_url);
          if (raw?.hostname === 'raw.githubusercontent.com' && raw.pathname.startsWith(`/${repo}/`)) {
            for (const link of documentLinks(markdown, raw.href)) if (/\.pdf$/i.test(link.pathname)) pdfs.set(link.href, { url: link, artifact: true, availabilityUrl: url });
          }
        });
        if (verifiedReadme) await read(new URL(`https://api.github.com/repos/${repo}/contents/`), 'artifact', doc => {
          const entries = z.array(z.object({ type: z.string(), name: z.string().max(300), download_url: z.string().nullable() })).max(1000).parse(JSON.parse(doc.text));
          for (const entry of entries.filter(entry => entry.type === 'file' && /\.pdf$/i.test(entry.name)).slice(0, 2)) {
            const url = safe(entry.download_url);
            if (url?.hostname === 'raw.githubusercontent.com' && url.pathname.startsWith(`/${repo}/`)) pdfs.set(url.href, { url, artifact: true, availabilityUrl: `https://github.com/${repo}` });
          }
        });
      }
      // Prioritize verified author preprints over paywalled publisher URLs; at most two attempts.
      const ordered = [...pdfs.values()].sort((a, b) => Number(b.artifact) - Number(a.artifact));
      for (const candidate of ordered.slice(0, 2)) {
        await read(candidate.url, 'fulltext', doc => {
          const front = doc.text.split('\f')[0].slice(0, 12000);
          const normalized = referenceIdentity(front);
          const frontDois = front.match(/\b10\.\d{4,9}\/[^\s<>"“”]+/gi)?.map(value => referenceDoi(value.replace(/[.,;:]+$/, ''))) ?? [];
          const author = paper.authors.some(name => surname(name).length > 1 && normalized.split(' ').includes(surname(name)));
          if (!normalized.includes(referenceIdentity(paper.title)) || !(doi && frontDois.includes(doi) || candidate.artifact && author)) throw new Error('PDF paper identity mismatch');
          benchmarks.push(...discoverBenchmarks({ kind: 'fulltext', text: doc.text, url: candidate.url.href, availabilityUrl: candidate.availabilityUrl }));
          if (!fields.includes('fulltext')) fields.push('fulltext');
        }, true);
        if (fields.includes('fulltext')) break;
      }
      return result();
    } finally { this.active--; }
  }
}
