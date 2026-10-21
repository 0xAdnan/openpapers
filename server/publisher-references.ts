import { z } from 'zod';
import { doiIdentifier } from '../shared/identifiers.ts';
import { normalizeText } from '../shared/fuzzy.ts';
import { PersistentCache } from './cache.ts';
import type { OpenAlexWork } from './openalex.ts';

const TTL = 6 * 60 * 60 * 1000;
const ReferenceSchema = z.object({ doi: z.string(), title: z.string(), references: z.array(z.string()).max(50), fetchedAt: z.string().datetime() });
const identity = (title: string) => normalizeText(title).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Accept DOI identifiers, not arbitrary URLs or OpenAlex filter syntax. */
export function referenceDoi(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 200 || /[\s,|\x00-\x1f\x7f]/.test(value)) return;
  const doi = doiIdentifier(value).toLowerCase();
  return /^10\.\d{4,9}\/[^\s,|\x00-\x1f\x7f]+$/.test(doi) ? doi : undefined;
}

export class PublisherReferences {
  private active = 0;
  private calls = 0;
  private day = '';
  private cooldownUntil = 0;
  constructor(private cache: PersistentCache, private options: { fetch?: typeof fetch; timeoutMs?: number } = {}) {}

  async lookup(origin: OpenAlexWork, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const doi = referenceDoi(origin.doi), title = identity(origin.display_name ?? '');
    if (!doi || !title || title === 'untitled work') return;
    const key = `crossref:references:v1:${doi}`;
    const entry = await this.cache.get<unknown>(key);
    signal?.throwIfAborted();
    if (entry?.value === null) return;
    const stored = ReferenceSchema.safeParse(entry?.value);
    if (stored.success && stored.data.doi === doi && identity(stored.data.title) === title &&
        stored.data.references.every(ref => referenceDoi(ref) === ref) && Date.parse(stored.data.fetchedAt) + TTL > Date.now()) return stored.data;
    const result = await this.cache.deduplicate(key, async sharedSignal => {
      const deadline = AbortSignal.any([sharedSignal, AbortSignal.timeout(this.options.timeoutMs ?? 3000)]);
      const today = new Date().toISOString().slice(0, 10);
      if (today !== this.day) { this.day = today; this.calls = 0; }
      if (this.active >= 2 || this.calls >= 100 || Date.now() < this.cooldownUntil) return;
      this.active++; this.calls++;
      try {
        // Fixed HTTPS origin; even a DOI containing slashes remains one encoded path segment.
        const response = await (this.options.fetch ?? fetch)(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
          signal: deadline, redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'OpenPapers/0.1 (publisher reference recovery)' },
        });
        if (!response.ok) { await response.body?.cancel(); throw new Error('Publisher metadata unavailable'); }
        if (!response.body) throw new Error('Missing publisher response');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 1024 * 1024) { await reader.cancel(); throw new Error('Publisher metadata too large'); }
          chunks.push(value);
        }
        deadline.throwIfAborted();
        const parsed = z.object({ message: z.object({ DOI: z.string().max(200), title: z.array(z.string().max(4000)).min(1).max(20),
          reference: z.array(z.object({ DOI: z.string().max(200).optional() })).max(5000).default([]),
        }) }).parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))).message;
        if (referenceDoi(parsed.DOI) !== doi || identity(parsed.title[0]) !== title) throw new Error('Publisher identity mismatch');
        const result = ReferenceSchema.parse({ doi, title: parsed.title[0], fetchedAt: new Date().toISOString(),
          references: [...new Set(parsed.reference.map(ref => referenceDoi(ref.DOI)).filter((ref): ref is string => !!ref && ref !== doi))].slice(0, 50) });
        await this.cache.set(key, result, TTL);
        return result;
      } catch {
        sharedSignal.throwIfAborted();
        this.cooldownUntil = Date.now() + 30000;
        await this.cache.set(key, null, 30000);
        return;
      } finally { this.active--; }
    }, signal);
    return result && result.doi === doi && identity(result.title) === title ? result : undefined;
  }
}
