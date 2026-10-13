import { z } from 'zod';
import { GraphResponseSchema } from './schemas';

export const GRAPH_JOB_VERSION = 'neighborhood-v1-indexed-v2';
export const GraphJobSchema = z.object({
  id: z.string().uuid(),
  origins: z.array(z.string().regex(/^W[1-9]\d{0,14}$/)).min(1).max(3),
  state: z.enum(['queued', 'running', 'paused', 'completed', 'failed']),
  phase: z.enum(['acquire', 'score', 'publish']),
  candidateBudget: z.number().int().min(40).max(50000),
  acquiredCount: z.number().int().nonnegative().max(50000),
  referenceCount: z.number().int().nonnegative().max(2000000),
  referenceBudget: z.number().int().min(1000).max(2000000),
  requestsUsed: z.number().int().nonnegative(),
  requestBudget: z.number().int().positive().max(1500),
  createdAt: z.string(), updatedAt: z.string(), nextRunAt: z.string().nullable(),
  stopReason: z.string().nullable(), error: z.string().nullable(),
  result: GraphResponseSchema.nullable(),
});
export type GraphJob = z.infer<typeof GraphJobSchema>;
export interface FrontierTask {
  kind: 'seed' | 'batch' | 'citing' | 'shared';
  ids: string[];
  cursor?: string;
  order?: 'cited_by_count:desc' | 'publication_date:desc';
  depth: number;
  pages?: number;
}
export interface JobCheckpoint {
  frontier: FrontierTask[];
  expanded: string[];
  seeded: string[];
}
export interface LeasedGraphJob extends GraphJob {
  leaseToken: string;
  checkpoint: JobCheckpoint;
}
export interface PageCommit {
  papers: import('./types').Paper[];
  fetchedAt: string;
  checkpoint: JobCheckpoint;
  requestUsed: boolean;
  state?: 'queued' | 'paused' | 'completed' | 'failed';
  nextRunAt?: string | null;
  stopReason?: string | null;
  error?: string | null;
  result?: import('./types').GraphResponse;
  phase?: 'acquire' | 'score' | 'publish';
}
