import type { ProviderId } from './providers';

export interface Paper {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string;
  citations: number;
  references: string[];
  abstract: string;
  doi: string | null;
  url: string;
  pdfUrl: string | null;
  openAccess: boolean;
  topics: string[];
}

export interface GraphPaper extends Paper {
  similarity: number;
  sharedReferences: number;
  coCitations: number;
  graphConnections: number;
  isOrigin: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
  weight: number;
  sharedReferences: number;
  coCitations: number;
  // An origin and a paper it cites or is cited by, with no similarity evidence; weight is 0.
  directCitation?: true;
}

export interface DataMeta {
  source: 'live' | 'snapshot' | 'cache';
  fetchedAt: string;
  warning?: string;
  provider?: ProviderId;
}

export interface GraphResponse {
  origins: string[];
  nodes: GraphPaper[];
  edges: GraphEdge[];
  prior: GraphPaper[];
  derivative: GraphPaper[];
  meta: DataMeta & {
    candidateCount: number;
    algorithm: string;
    coverage: string;
    candidateBudget?: number;
    referenceCount?: number;
    jobId?: string;
    acquisitionStop?: string;
    fallback?: {
      from: 'openalex';
      requestedOrigins: string[];
      resolvedOrigins: string[];
      reason: 'limited_connections' | 'openalex_unavailable';
      comparison: {
        openalex: { nodes: number; edges: number; connectedOrigins: number; candidates: number } | null;
        semanticScholar: { nodes: number; edges: number; connectedOrigins: number; candidates: number };
      };
    };
  };
}

export interface SearchResponse {
  results: Paper[];
  total: number;
  page: number;
  perPage: number;
  meta: DataMeta;
}

export interface Example {
  id: string;
  title: string;
  field: string;
  author: string;
  year: number;
  warning?: string;
  provider?: ProviderId;
}

export interface GraphCanvasProps {
  nodes: GraphPaper[];
  edges: GraphEdge[];
  selectedId: string;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  // Hover previews a paper without changing the selection; null when the pointer leaves.
  onHover?: (id: string | null) => void;
}
