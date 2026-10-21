import { z } from 'zod';
import { PAPER_ID_PATTERN } from './providers';

// Keep validation compatible with the production CSP without generated functions.
z.config({ jitless: true });

const id = z.string().regex(PAPER_ID_PATTERN);
const date = z.string().refine(value => Number.isFinite(Date.parse(value)));
const url = z.string().max(2000).refine(value => {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch { return false; }
});
const count = z.number().int().nonnegative();
export const PaperSchema = z.object({
  id, title: z.string().min(1).max(2000), authors: z.array(z.string().max(300)).max(100),
  year: z.number().int().nullable(), venue: z.string().max(500), citations: z.number().nonnegative(),
  references: z.array(id).max(2500), abstract: z.string().max(30000), doi: url.nullable(),
  url, pdfUrl: url.nullable(), openAccess: z.boolean(), topics: z.array(z.string().max(300)).max(12),
});
const provider = z.enum(['openalex', 'semantic-scholar']);
export const ProvidersSchema = z.object({ defaultProvider: provider, providers: z.array(z.object({ id: provider, name: z.string(), keyConfigured: z.boolean(), offline: z.boolean() })).max(2) });
const meta = z.object({ source: z.enum(['live', 'cache', 'snapshot']), fetchedAt: date, warning: z.string().optional(), provider: provider.optional() });
export const PaperResponseSchema = z.object({ paper: PaperSchema, meta });
export const ExamplesSchema = z.array(z.object({ id, title: z.string().min(1), field: z.string(), author: z.string(), year: z.number().int(), warning: z.string().optional(), provider: provider.optional() })).max(20);
export const CandidatePoolSchema = z.object({
  origin: id, papers: z.array(PaperSchema).min(1).max(300), fetchedAt: date,
  source: z.enum(['live', 'cache']), coverage: z.string(), provider: provider.optional(),
  referenceRecovery: z.enum(['crossref-v1', 'bibliography-v2']).optional(),
}).refine(pool => pool.papers.some(paper => paper.id === pool.origin) && new Set(pool.papers.map(paper => paper.id)).size === pool.papers.length);
export const SearchResponseSchema = z.object({
  results: z.array(PaperSchema).max(20), total: count, page: z.number().int().min(1).max(100),
  perPage: z.literal(20), meta,
});
const graphPaper = PaperSchema.extend({
  similarity: z.number().min(0).max(1), sharedReferences: count, coCitations: count,
  graphConnections: count, isOrigin: z.boolean(),
});
const graphCoverage = z.object({ nodes: count, edges: count, connectedOrigins: count, candidates: count });
export const GraphResponseSchema = z.object({
  origins: z.array(id).min(1).max(3), nodes: z.array(graphPaper).min(1).max(40),
  edges: z.array(z.object({ source: id, target: id, weight: z.number().min(0).max(1), sharedReferences: count, coCitations: count, directCitation: z.literal(true).optional() })).max(780),
  prior: z.array(graphPaper).max(20), derivative: z.array(graphPaper).max(20),
  meta: meta.extend({ candidateCount: count.max(50000), algorithm: z.string(), coverage: z.string(),
    candidateBudget: count.max(50000).optional(), referenceCount: count.max(2000000).optional(),
    jobId: z.string().uuid().optional(), acquisitionStop: z.string().optional(),
    fallback: z.object({ from: z.literal('openalex'), requestedOrigins: z.array(z.string().regex(/^W[1-9]\d{0,14}$/)).min(1).max(3),
      resolvedOrigins: z.array(z.string().regex(/^S2:[a-f0-9]{40}$/)).min(1).max(3),
      reason: z.enum(['limited_connections', 'openalex_unavailable']),
      comparison: z.object({ openalex: graphCoverage.nullable(), semanticScholar: graphCoverage }),
    }).optional(),
  }),
}).refine(graph => {
  const nodes = new Set(graph.nodes.map(paper => paper.id));
  return nodes.size === graph.nodes.length && new Set(graph.origins).size === graph.origins.length &&
    (!graph.meta.fallback || (graph.meta.provider === 'semantic-scholar' &&
      graph.meta.fallback.requestedOrigins.length === graph.meta.fallback.resolvedOrigins.length &&
      new Set(graph.meta.fallback.requestedOrigins).size === graph.meta.fallback.requestedOrigins.length &&
      graph.meta.fallback.resolvedOrigins.join(',') === graph.origins.join(','))) &&
    graph.origins.every(origin => graph.nodes.some(paper => paper.id === origin && paper.isOrigin)) &&
    graph.nodes.every(paper => paper.isOrigin === graph.origins.includes(paper.id)) &&
    graph.edges.every(edge => nodes.has(edge.source) && nodes.has(edge.target) && edge.source !== edge.target && (edge.directCitation
      ? edge.weight === 0 && edge.sharedReferences + edge.coCitations === 0
      : edge.weight > 0 && edge.sharedReferences + edge.coCitations > 0));
});
