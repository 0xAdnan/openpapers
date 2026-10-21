import { z } from 'zod';
import { PaperResponseSchema, PaperSchema } from './schemas.ts';

const text = z.string().trim().min(1).max(160).regex(/^[\p{L}\p{N} ._+/#:()\-]+$/u);
const numeric = (min: number, max: number) => z.union([z.number(), z.string().regex(/^\d{1,4}$/)]).pipe(z.coerce.number<string | number>().int().min(min).max(max));
const year = numeric(1900, 2100);
export const BenchmarkQuerySchema = z.object({
  q: text,
  page: numeric(1, 100).default(1),
  sort: z.enum(['newest', 'oldest', 'citations']).default('newest'),
  evidence: z.enum(['any', 'abstract', 'title']).default('any'),
  publication: z.enum(['any', 'conference', 'journal', 'published']).default('any'),
  from: year.optional(), to: year.optional(),
  oa: z.enum(['1']).optional(), pdf: z.enum(['1']).optional(),
  keyword: text.optional(),
}).strict().refine(query => query.from === undefined || query.to === undefined || query.from <= query.to, {
  message: 'From year must not be after to year',
});
export type BenchmarkQuery = z.output<typeof BenchmarkQuerySchema>;

/** Small, explicit request grammar; this is not an unrestricted chat model. */
export function resolveBenchmark(value: string) {
  const name = value.trim().replace(/^(?:(?:the |my )?benchmark\s*(?:is|:|=)\s*|(?:find|show|list)(?: me)?(?: all)?(?: the)? papers (?:using|on|for|that use)\s+)/i, '').trim();
  // Generic spelling variants, not a benchmark-name registry.
  const compact = name.replace(/[\s_-]+/g, '');
  return { name, aliases: [...new Set([name, ...(compact !== name ? [compact] : [])])], url: null };
}

const PublicationSchema = z.object({
  kind: z.enum(['conference', 'journal', 'preprint', 'other', 'unknown']),
  published: z.boolean().nullable(),
});

export const BenchmarkResponseSchema = z.object({
  benchmark: z.object({ name: z.string().min(1).max(160), aliases: z.array(z.string().max(160)).min(1).max(5), url: z.string().url().nullable() }),
  results: z.array(z.object({
    paper: PaperSchema,
    publicationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    publication: PublicationSchema.default({ kind: 'unknown', published: null }),
    evidence: z.object({ kind: z.enum(['title', 'abstract', 'indexed']), excerpt: z.string().max(500) }),
  })).max(20),
  total: z.number().int().nonnegative(), page: z.number().int().min(1).max(100), perPage: z.literal(20),
  meta: z.object({ source: z.enum(['live', 'cache', 'snapshot']), provider: z.literal('openalex'),
    fetchedAt: z.string().refine(value => Number.isFinite(Date.parse(value))), warning: z.string().optional(), coverage: z.string() }),
}).refine(response => response.results.every(({ paper }) => /^W[1-9]\d{0,14}$/.test(paper.id) && paper.references.every(id => /^W[1-9]\d{0,14}$/.test(id))) &&
  new Set(response.results.map(result => result.paper.id)).size === response.results.length);
export type BenchmarkResponse = z.output<typeof BenchmarkResponseSchema>;

export const PaperBenchmarksResponseSchema = PaperResponseSchema.extend({
  benchmarks: z.array(z.object({
    name: z.string().min(1).max(160), url: z.string().url().nullable(),
    category: z.enum(['named', 'suite']),
    evidence: z.object({ kind: z.enum(['title', 'abstract', 'fulltext', 'artifact']), excerpt: z.string().min(1).max(500),
      sourceUrl: z.string().url(), section: z.string().max(200).optional() }),
  })).max(50),
  coverage: z.object({ fields: z.array(z.enum(['title', 'abstract', 'fulltext', 'artifact'])).min(1).max(4),
    discovery: z.object({ status: z.enum(['complete', 'partial', 'unavailable']),
      sources: z.array(z.object({ kind: z.enum(['fulltext', 'artifact', 'metadata']), url: z.string().url(),
        status: z.enum(['read', 'unavailable', 'rejected']), fetchedAt: z.string().datetime().optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() })).max(20),
      limitations: z.string().max(2000),
    }),
  }),
});
export type PaperBenchmarksResponse = z.output<typeof PaperBenchmarksResponseSchema>;

export function benchmarkEvidence(paper: { title: string; abstract: string }, aliases: string[], ignoredAliases: string[] = []): BenchmarkResponse['results'][number]['evidence'] {
  const pattern = (alias: string) => new RegExp(`(?<![\\p{L}\\p{N}])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'giu');
  const patterns = aliases.map(pattern);
  for (const kind of ['title', 'abstract'] as const) {
    const content = paper[kind];
    const excluded = ignoredAliases.flatMap(alias => [...content.matchAll(pattern(alias))].map(match => ({ start: match.index, end: match.index + match[0].length })));
    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) {
        if (excluded.some(span => match.index < span.end && match.index + match[0].length > span.start)) continue;
        const start = Math.max(0, match.index - 100), end = Math.min(content.length, match.index + match[0].length + 180);
        return { kind, excerpt: `${start ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}` };
      }
    }
  }
  return { kind: 'indexed', excerpt: '' };
}
