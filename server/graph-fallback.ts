import { normalizeText } from '../shared/fuzzy.ts';
import { doiIdentifier } from '../shared/identifiers.ts';
import { S2_ID_PATTERN } from '../shared/providers.ts';
import { GraphResponseSchema } from '../shared/schemas.ts';
import type { GraphResponse, Paper } from '../shared/types.ts';
import { ID_PATTERN } from './openalex.ts';
import type { SemanticService } from './semantic-service.ts';
import { normalizeSemanticPaper, semanticLookup } from './semantic-scholar.ts';
import { ApiError, type PaperService } from './service.ts';

export function graphCoverage(graph: GraphResponse) {
  const nodes = new Set(graph.nodes.map(p => p.id));
  const connected = new Set(graph.edges.filter(e => nodes.has(e.source) && nodes.has(e.target) && e.source !== e.target)
    .flatMap(e => [e.source, e.target]));
  return { nodes: graph.nodes.length, edges: graph.edges.length,
    connectedOrigins: graph.origins.filter(id => nodes.has(id) && connected.has(id)).length,
    candidates: graph.meta.candidateCount };
}

const identityText = (value: string) => normalizeText(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const doi = (paper: Paper) => paper.doi ? doiIdentifier(paper.doi).trim().toLowerCase() : null;

function identityMatches(origin: Paper, candidate: Paper, mode: 'title' | 'arxiv' | 'doi' = 'title') {
  const title = identityText(origin.title);
  if (!title || title === 'untitled work' || title !== identityText(candidate.title)) return false;
  if (doi(origin) && doi(candidate) && doi(origin) !== doi(candidate)) return false;
  const yearKnown = origin.year !== null && candidate.year !== null;
  const authors = origin.authors.map(identityText).filter(Boolean);
  const otherAuthors = candidate.authors.map(identityText).filter(Boolean);
  const authorsKnown = authors.length > 0 && otherAuthors.length > 0;
  const overlap = authors.some(name => otherAuthors.includes(name));
  if (yearKnown && origin.year !== candidate.year || authorsKnown && !overlap) return false;
  return mode === 'doi' || (mode === 'arxiv' ? yearKnown || overlap : yearKnown && overlap);
}

function arxivAlias(value: string) {
  // Only official abs/pdf URLs establish an arXiv identity, never arbitrary landing URLs.
  if (value.length > 2000 || /[\x00-\x20\x7f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !['arxiv.org', 'www.arxiv.org'].includes(url.hostname) ||
        url.username || url.password || url.port || url.search || url.hash || !/^\/(?:abs|pdf)\//.test(url.pathname)) return null;
    const alias = semanticLookup(value);
    return alias?.startsWith('ARXIV:') ? alias : null;
  } catch { return null; }
}

export class GraphFallbackCoordinator {
  constructor(private readonly openalex: Pick<PaperService, 'graph' | 'paper'>,
    private readonly semantic: Pick<SemanticService, 'graph' | 'search'> & {
      provider: Pick<SemanticService['provider'], 'getPaper'>;
    }, private readonly enabled = false) {}

  async graph(origins: string[], signal?: AbortSignal): Promise<GraphResponse> {
    signal?.throwIfAborted();
    if (!origins.length || origins.length > 3 || new Set(origins).size !== origins.length || origins.some(id => !ID_PATTERN.test(id))) {
      throw new ApiError(400, 'Choose one to three distinct canonical OpenAlex IDs');
    }
    origins = [...origins];
    let original: GraphResponse | undefined, originalError: unknown;
    try {
      original = await this.openalex.graph(origins, signal);
      signal?.throwIfAborted();
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) throw error;
      if (!this.enabled || !(error instanceof ApiError) || ![503, 404].includes(error.status) || error.code === 'origin_not_found') throw error;
      originalError = error;
    }
    if (original && (!this.enabled || original.nodes.length > 3 && original.edges.length > 0)) return original;

    try {
      // Resolve every exact OA origin before any S2 work, including a neighborhood-level 404.
      const papers: Paper[] = [];
      for (const id of origins) {
        signal?.throwIfAborted();
        const paper = original?.nodes.find(p => p.id === id && p.isOrigin) ?? (await this.openalex.paper(id, signal)).paper;
        signal?.throwIfAborted();
        if (paper.id !== id) throw new Error('OpenAlex origin identity mismatch');
        papers.push(paper);
      }
      const resolved: string[] = [];
      for (const paper of papers) {
        signal?.throwIfAborted();
        const alias = arxivAlias(paper.url);
        let matches: Paper[];
        if (alias) {
          // Search normalization omits ArXiv. One raw alias lookup verifies it and warms the provider cache.
          const record = await this.semantic.provider.getPaper(alias, signal);
          signal?.throwIfAborted();
          const rawAlias = record.externalIds?.ArXiv;
          const candidate = normalizeSemanticPaper(record);
          matches = rawAlias && semanticLookup(`ARXIV:${rawAlias}`)?.toLowerCase() === alias.toLowerCase() &&
            identityMatches(paper, candidate, 'arxiv') ? [candidate] : [];
        } else if (paper.doi) {
          if (paper.doi.length > 200 || /[\x00-\x1f\x7f]/.test(paper.doi)) throw new Error('Unusable origin DOI');
          const response = await this.semantic.search(paper.doi, 1, signal);
          signal?.throwIfAborted();
          matches = response.results.filter(candidate => doi(candidate) === doi(paper) && identityMatches(paper, candidate, 'doi'));
        } else {
          const title = paper.title.trim();
          if (!title || title.length > 200 || /[\x00-\x1f\x7f]/.test(title)) throw new Error('Unusable origin title');
          const response = await this.semantic.search(title, 1, signal);
          signal?.throwIfAborted();
          matches = response.results.filter(candidate => identityMatches(paper, candidate));
        }
        const unique = [...new Set(matches.map(p => p.id))];
        if (unique.length !== 1 || !S2_ID_PATTERN.test(unique[0]) || resolved.includes(unique[0])) {
          throw new Error('No unique Semantic Scholar origin identity');
        }
        resolved.push(unique[0]);
      }
      signal?.throwIfAborted();
      const alternative = await this.semantic.graph(resolved, signal);
      signal?.throwIfAborted();
      if (!GraphResponseSchema.safeParse(alternative).success || alternative.meta.provider !== 'semantic-scholar' ||
          alternative.origins.join(',') !== resolved.join(',') ||
          [...alternative.nodes, ...alternative.prior, ...alternative.derivative].some(p => !S2_ID_PATTERN.test(p.id) || p.references.some(id => !S2_ID_PATTERN.test(id)))) {
        throw new Error('Invalid Semantic Scholar graph');
      }
      const openalex = original ? graphCoverage(original) : null, semanticScholar = graphCoverage(alternative);
      if (semanticScholar.nodes < 1 || semanticScholar.edges === 0 || openalex &&
          (semanticScholar.nodes < openalex.nodes || semanticScholar.edges < openalex.edges || semanticScholar.connectedOrigins < openalex.connectedOrigins ||
          !(semanticScholar.nodes > openalex.nodes || semanticScholar.edges > openalex.edges || semanticScholar.connectedOrigins > openalex.connectedOrigins))) {
        throw new Error('Semantic Scholar graph does not improve coverage');
      }
      return { ...alternative, meta: { ...alternative.meta,
        warning: [alternative.meta.warning,
          original ? 'OpenAlex has limited graph connections; showing an independently resolved Semantic Scholar graph.'
            : 'OpenAlex graph connections are unavailable; showing an independently resolved Semantic Scholar graph.',
          'Semantic Scholar missing references, abstracts, and indexing gaps can limit coverage; this graph is sampled, not exhaustive.']
          .filter(Boolean).join(' '),
        fallback: { from: 'openalex', requestedOrigins: origins, resolvedOrigins: resolved,
          reason: original ? 'limited_connections' : 'openalex_unavailable', comparison: { openalex, semanticScholar } },
      } };
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) throw error;
      if (original) return original;
      throw originalError;
    }
  }
}
