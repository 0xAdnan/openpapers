import type { GraphJob, LeasedGraphJob, PageCommit } from '../shared/graph-jobs.ts';
import type { Paper } from '../shared/types.ts';

export interface GraphJobStore {
  ready: Promise<void>;
  /** callerKey is a server-verified SHA-256 hash; omission is for internal operators only. */
  create(origins: string[], candidateBudget: number, requestBudget: number, callerKey?: string): Promise<GraphJob>;
  get(id: string): Promise<GraphJob | undefined>;
  claim(id?: string): Promise<LeasedGraphJob | undefined>;
  reserveRequest(job: LeasedGraphJob): Promise<{ allowed: boolean; nextRunAt: string | null }>;
  commit(job: LeasedGraphJob, page: PageCommit): Promise<GraphJob>;
  papers(job: LeasedGraphJob, signal?: AbortSignal): Promise<Paper[]>;
  close(): Promise<void>;
}
