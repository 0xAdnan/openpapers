import { createHash, randomUUID } from 'node:crypto';
import pg, { type PoolClient, type PoolConfig, type QueryConfig } from 'pg';
import { z } from 'zod';
import { GRAPH_JOB_VERSION, GraphJobSchema, type GraphJob, type LeasedGraphJob, type PageCommit } from '../shared/graph-jobs.ts';
import { GraphResponseSchema, PaperSchema } from '../shared/schemas.ts';
import type { Paper } from '../shared/types.ts';
import type { GraphJobStore } from './graph-store.ts';
import { SUPABASE_CA } from './supabase-ca.ts';

const MIGRATION = '202610140001_graph_jobs';
const RESOURCE_LOCK = '764521340002';
const PAPER_READ_BATCH = 2000;
const oaId = z.string().regex(/^W[1-9]\d{0,14}$/);
const timestamp = z.string().max(100).datetime({ offset: true });
const checkpointSchema = z.object({
  frontier: z.array(z.object({
    kind: z.enum(['seed', 'batch', 'citing', 'shared']),
    ids: z.array(oaId).min(1).max(100), cursor: z.string().min(1).max(2000).optional(),
    order: z.enum(['cited_by_count:desc', 'publication_date:desc']).optional(),
    depth: z.number().int().min(0).max(2), pages: z.number().int().min(0).max(1000).optional(),
    attempts: z.number().int().min(0).max(3).optional(),
  }).strict()).max(1000),
  expanded: z.array(oaId).max(50000), seeded: z.array(oaId).max(3),
  firstFetchedAt: timestamp.optional(), missingReferences: z.number().int().min(0).max(150000).optional(),
  skippedTasks: z.number().int().min(0).max(1500).optional(), cursorStalls: z.number().int().min(0).max(1500).optional(),
}).strict();
const storedCheckpointSchema = checkpointSchema.extend({ version: z.literal(1) });
const oaPaperSchema = PaperSchema.extend({ id: oaId, references: z.array(oaId).max(2500) });
const pageSchema = z.object({
  papers: z.array(oaPaperSchema).max(100), fetchedAt: timestamp, checkpoint: checkpointSchema,
  requestUsed: z.boolean(), state: z.enum(['queued', 'paused', 'completed', 'failed']).optional(),
  nextRunAt: timestamp.nullable().optional(), stopReason: z.string().max(200).nullable().optional(),
  error: z.string().max(2000).nullable().optional(), result: GraphResponseSchema.optional(),
  phase: z.enum(['acquire', 'score', 'publish']).optional(),
  providerCooldownUntil: timestamp.nullable().optional(),
}).strict();

export interface PostgresGraphStoreOptions {
  max?: 1 | 2;
  dailyRequestBudget?: number;
  referenceBudget?: number;
  totalReferenceBudget?: number;
  totalMetadataBytes?: number;
  leaseMs?: number;
  pacingMs?: number;
  maxActiveJobs?: number;
  maxCompletedJobs?: number;
  retentionMs?: number;
  /** PEM certificate authority for a remote server; verification is never disabled. */
  ca?: string;
}

/** Strip pg's SSL URL overrides so sslmode=require cannot disable verification. */
export function graphPostgresPoolConfig(databaseUrl: string, options: Pick<PostgresGraphStoreOptions, 'max' | 'ca'> = {}): PoolConfig {
  let url: URL;
  try { url = new URL(databaseUrl); } catch { throw new Error('Invalid graph database URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) {
    throw new Error('Invalid graph database URL');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  const sslMode = url.searchParams.get('sslmode');
  if (local && sslMode && !['disable', 'verify-full'].includes(sslMode)) throw new Error('Local graph database sslmode must be disable or verify-full');
  if (!local && sslMode && sslMode !== 'verify-full') throw new Error('Remote graph database requires verified TLS (sslmode=verify-full)');
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS verification must not be disabled');
  for (const key of [...url.searchParams.keys()]) {
    if (!['sslmode', 'sslrootcert'].includes(key)) throw new Error('Unsupported graph database URL option');
    if (key === 'sslrootcert') throw new Error('Supply the database CA with GRAPH_DATABASE_CA, not a URL file option');
    url.searchParams.delete(key);
  }
  const max = z.union([z.literal(1), z.literal(2)]).parse(options.max ?? 2);
  const ca = options.ca ?? (url.hostname.endsWith('.pooler.supabase.com') || url.hostname.endsWith('.supabase.co') ? SUPABASE_CA : undefined);
  return {
    connectionString: url.toString(), max,
    ssl: local && (!sslMode || sslMode === 'disable') ? false : { rejectUnauthorized: true, ...(ca ? { ca } : {}), minVersion: 'TLSv1.2' },
    connectionTimeoutMillis: 20000, query_timeout: 20000, statement_timeout: 20000,
    lock_timeout: 20000, idle_in_transaction_session_timeout: 20000,
    idleTimeoutMillis: 30000, application_name: 'openpapers-graph-jobs',
  };
}

function boundedJson(value: unknown, max: number, label: string): string {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > max) throw new Error(`${label} is too large`);
  return json;
}

type Row = Record<string, any>;
function publicJob(row: Row): GraphJob {
  const result = row.result == null ? null : z.object({ version: z.literal(1), graph: GraphResponseSchema }).parse(row.result).graph;
  return GraphJobSchema.parse({
    id: row.id, origins: row.origins, state: row.state, phase: row.phase,
    candidateBudget: row.candidate_budget, acquiredCount: row.acquired_count,
    referenceBudget: row.reference_budget, referenceCount: row.reference_count,
    requestsUsed: row.requests_used, requestBudget: row.request_budget,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    nextRunAt: row.next_run_at?.toISOString() ?? null, stopReason: row.stop_reason, error: row.error, result,
  });
}

export class PostgresGraphStore implements GraphJobStore {
  readonly ready: Promise<void>;
  private readonly pool: pg.Pool;
  private closing?: Promise<void>;
  private readonly limits: Required<Omit<PostgresGraphStoreOptions, 'max' | 'ca'>>;

  constructor(databaseUrl: string = process.env.DATABASE_URL ?? '', options: PostgresGraphStoreOptions = {}) {
    if (!databaseUrl) throw new Error('DATABASE_URL is required for durable graph jobs');
    const integer = (value: number | string | undefined, fallback: number, min: number, max: number) =>
      z.number().int().min(min).max(max).parse(value === undefined ? fallback : Number(value));
    this.limits = {
      dailyRequestBudget: integer(options.dailyRequestBudget ?? process.env.GRAPH_DAILY_REQUEST_BUDGET, process.env.PAPERS_API_KEY ? 1500 : 50, 1, 1500),
      referenceBudget: integer(options.referenceBudget ?? process.env.GRAPH_REFERENCE_BUDGET, 500000, 1000, 2000000),
      totalReferenceBudget: integer(options.totalReferenceBudget ?? process.env.GRAPH_TOTAL_REFERENCE_BUDGET, 1000000, 1000, 2000000),
      totalMetadataBytes: integer(options.totalMetadataBytes ?? process.env.GRAPH_TOTAL_METADATA_BYTES, 64 * 1024 * 1024, 1024, 256 * 1024 * 1024),
      leaseMs: integer(options.leaseMs, 120000, 50, 300000), pacingMs: integer(options.pacingMs, 250, 0, 60000),
      maxActiveJobs: integer(options.maxActiveJobs, 4, 1, 4), maxCompletedJobs: integer(options.maxCompletedJobs, 30, 0, 30),
      retentionMs: integer(options.retentionMs, 7 * 86400000, 1, 7 * 86400000),
    };
    this.pool = new pg.Pool(graphPostgresPoolConfig(databaseUrl, { ...options, ca: options.ca ?? process.env.GRAPH_DATABASE_CA }));
    // Idle connection errors must not crash the process or leak a connection URL.
    this.pool.on('error', () => {});
    this.ready = this.pool.query(`SELECT version,
      to_regclass('openpapers.graph_jobs') IS NOT NULL AND to_regclass('openpapers.job_papers') IS NOT NULL
        AND to_regclass('openpapers.job_references') IS NOT NULL AND to_regclass('openpapers.provider_budget') IS NOT NULL
        AND to_regclass('openpapers.graph_admission') IS NOT NULL
        AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'openpapers'
          AND table_name = 'graph_jobs' AND column_name = 'caller_key') AS present
      FROM openpapers.schema_migrations WHERE version = $1`, [MIGRATION])
      .then(({ rows }) => { if (!rows.length || !rows[0].present) throw new Error('Graph database migration is missing'); });
  }

  private async transaction<T>(fn: (client: PoolClient) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    await this.ready;
    signal?.throwIfAborted();
    const client = await this.pool.connect();
    let destroy = false;
    try {
      signal?.throwIfAborted();
      await client.query('BEGIN');
      signal?.throwIfAborted();
      const value = await fn(client);
      signal?.throwIfAborted();
      await client.query('COMMIT');
      return value;
    } catch (error) {
      // pg's driver timeout does not cancel SQL. Never return that connection to the pool.
      destroy = error instanceof Error && error.message === 'Query read timeout';
      if (!destroy) {
        try { await client.query('ROLLBACK'); } catch { destroy = true; }
      }
      throw error;
    } finally { client.release(destroy); }
  }

  private async lockedJob(client: PoolClient, job: LeasedGraphJob): Promise<Row> {
    const id = z.string().uuid().parse(job.id);
    const token = z.string().uuid().parse(job.leaseToken);
    const { rows } = await client.query(`SELECT * FROM openpapers.graph_jobs
      WHERE id = $1 AND lease_token = $2 AND state = 'running' AND lease_expires_at > clock_timestamp() FOR UPDATE`, [id, token]);
    if (!rows.length) throw new Error('Graph job lease is stale or expired');
    return rows[0];
  }

  private async prune(client: PoolClient): Promise<void> {
    // Callers hold RESOURCE_LOCK before taking job locks. Old workers lose their leases.
    await client.query(`UPDATE openpapers.graph_jobs SET state = 'failed', lease_token = NULL,
      lease_expires_at = NULL, request_reserved = false, next_run_at = NULL,
      checkpoint = '{"version":1,"frontier":[],"expanded":[],"seeded":[]}'::jsonb,
      stop_reason = CASE WHEN version <> $1 THEN 'incompatible_version' ELSE 'job_expired' END,
      error = CASE WHEN version <> $1 THEN 'Graph job version is no longer supported; submit again.'
        ELSE 'Graph job exceeded its 24-hour lifetime; submit again.' END,
      updated_at = clock_timestamp()
      WHERE state IN ('queued', 'running', 'paused')
        AND (version <> $1 OR created_at < clock_timestamp() - interval '24 hours')`, [GRAPH_JOB_VERSION]);
    await client.query(`DELETE FROM openpapers.graph_admission
      WHERE budget_day < (clock_timestamp() AT TIME ZONE 'UTC')::date`);
    await client.query(`DELETE FROM openpapers.graph_jobs WHERE id IN (
      SELECT id FROM (SELECT id, updated_at, row_number() OVER (ORDER BY updated_at DESC, id) AS rank
        FROM openpapers.graph_jobs WHERE state IN ('completed', 'failed')) retained
      WHERE rank > $1 OR updated_at < clock_timestamp() - $2 * interval '1 millisecond')`,
    [this.limits.maxCompletedJobs, this.limits.retentionMs]);
  }

  async create(origins: string[], candidateBudget: number, requestBudget: number, callerKey?: string): Promise<GraphJob> {
    const canonical = z.array(oaId).min(1).max(3).refine(ids => new Set(ids).size === ids.length).parse(origins).sort();
    z.number().int().min(40).max(50000).parse(candidateBudget);
    z.number().int().min(1).max(1500).parse(requestBudget);
    if (callerKey !== undefined) z.string().regex(/^[0-9a-f]{64}$/).parse(callerKey);
    const referenceBudget = Math.min(this.limits.referenceBudget, this.limits.totalReferenceBudget);
    const key = createHash('sha256').update(JSON.stringify([GRAPH_JOB_VERSION, canonical, candidateBudget, requestBudget, referenceBudget])).digest('hex');
    return this.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [RESOURCE_LOCK]);
      await this.prune(client);
      const existing = await client.query('SELECT * FROM openpapers.graph_jobs WHERE cache_key = $1', [key]);
      if (existing.rows.length && existing.rows[0].state !== 'failed') return publicJob(existing.rows[0]);
      if (existing.rows.length) await client.query('DELETE FROM openpapers.graph_jobs WHERE cache_key = $1 AND state = \'failed\'', [key]);
      const active = await client.query(`SELECT count(*)::integer AS count FROM openpapers.graph_jobs WHERE state IN ('queued', 'running', 'paused')`);
      if (active.rows[0].count >= this.limits.maxActiveJobs) throw new Error('Graph job queue is full');
      if (callerKey !== undefined) {
        const caller = await client.query(`SELECT 1 FROM openpapers.graph_jobs
          WHERE caller_key = $1 AND state IN ('queued', 'running', 'paused') LIMIT 1`, [callerKey]);
        if (caller.rows.length) throw new Error('Caller already has an active graph job');
        const admitted = await client.query(`INSERT INTO openpapers.graph_admission (caller_key, budget_day, submissions)
          VALUES ($1, (clock_timestamp() AT TIME ZONE 'UTC')::date, 1)
          ON CONFLICT (caller_key, budget_day) DO UPDATE SET submissions = graph_admission.submissions + 1
          WHERE graph_admission.submissions < 2 RETURNING caller_key`, [callerKey]);
        if (!admitted.rows.length) throw new Error('Caller daily graph submission limit reached');
      }
      const checkpoint = boundedJson({ version: 1, frontier: canonical.map(id => ({ kind: 'seed', ids: [id], depth: 0 })), expanded: [], seeded: [] }, 2097152, 'Checkpoint');
      const { rows } = await client.query(`INSERT INTO openpapers.graph_jobs
        (id, cache_key, version, origins, state, phase, candidate_budget, reference_budget, request_budget, checkpoint, caller_key)
        VALUES ($1, $2, $3, $4, 'queued', 'acquire', $5, $6, $7, $8::jsonb, $9) RETURNING *`,
      [randomUUID(), key, GRAPH_JOB_VERSION, canonical, candidateBudget, referenceBudget, requestBudget, checkpoint, callerKey ?? null]);
      return publicJob(rows[0]);
    });
  }

  async get(id: string): Promise<GraphJob | undefined> {
    if (!z.string().uuid().safeParse(id).success) return undefined;
    await this.ready;
    const { rows } = await this.pool.query('SELECT * FROM openpapers.graph_jobs WHERE id = $1', [id]);
    return rows.length ? publicJob(rows[0]) : undefined;
  }

  async claim(id?: string): Promise<LeasedGraphJob | undefined> {
    if (id !== undefined) z.string().uuid().parse(id);
    return this.transaction(async client => {
      const { rows } = await client.query(`WITH due AS (
        SELECT id FROM openpapers.graph_jobs WHERE version = $1 AND ($2::uuid IS NULL OR id = $2) AND (
          (state = 'queued' AND (next_run_at IS NULL OR next_run_at <= clock_timestamp())) OR
          (state = 'paused' AND next_run_at <= clock_timestamp()) OR
          (state = 'running' AND lease_expires_at <= clock_timestamp()))
        ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE openpapers.graph_jobs j SET state = 'running', lease_token = $3,
          lease_expires_at = clock_timestamp() + $4 * interval '1 millisecond',
          request_reserved = false, next_run_at = NULL, updated_at = clock_timestamp()
        FROM due WHERE j.id = due.id RETURNING j.*`, [GRAPH_JOB_VERSION, id ?? null, randomUUID(), this.limits.leaseMs]);
      if (!rows.length) return undefined;
      const { version: _version, ...checkpoint } = storedCheckpointSchema.parse(rows[0].checkpoint);
      return { ...publicJob(rows[0]), leaseToken: rows[0].lease_token, checkpoint };
    });
  }

  async reserveRequest(job: LeasedGraphJob): Promise<{ allowed: boolean; nextRunAt: string | null }> {
    return this.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [RESOURCE_LOCK]);
      const row = await this.lockedJob(client, job);
      if (row.request_reserved) throw new Error('An upstream request is already reserved for this lease');
      if (row.requests_used >= row.request_budget) return { allowed: false, nextRunAt: null };
      const { rows } = await client.query(`INSERT INTO openpapers.provider_budget (provider, budget_day, daily_budget)
        VALUES ('openalex', (clock_timestamp() AT TIME ZONE 'UTC')::date, $1)
        ON CONFLICT (provider) DO UPDATE SET
          daily_requests = CASE WHEN provider_budget.budget_day = EXCLUDED.budget_day THEN provider_budget.daily_requests ELSE 0 END,
          daily_budget = CASE WHEN provider_budget.budget_day = EXCLUDED.budget_day THEN least(provider_budget.daily_budget, EXCLUDED.daily_budget) ELSE EXCLUDED.daily_budget END,
          budget_day = EXCLUDED.budget_day RETURNING *, clock_timestamp() AS now`, [this.limits.dailyRequestBudget]);
      const budget = rows[0];
      const now = budget.now.getTime();
      let next = Math.max(budget.next_request_at.getTime(), budget.cooldown_until?.getTime() ?? 0);
      if (budget.daily_requests >= budget.daily_budget) {
        next = Math.max(next, Date.UTC(budget.now.getUTCFullYear(), budget.now.getUTCMonth(), budget.now.getUTCDate() + 1));
      }
      if (next > now) return { allowed: false, nextRunAt: new Date(next).toISOString() };
      const updated = await client.query(`UPDATE openpapers.graph_jobs SET requests_used = requests_used + 1,
        request_reserved = true, updated_at = clock_timestamp()
        WHERE id = $1 AND lease_token = $2 AND lease_expires_at > clock_timestamp() RETURNING id`, [row.id, job.leaseToken]);
      if (!updated.rows.length) throw new Error('Graph job lease is stale or expired');
      await client.query(`UPDATE openpapers.provider_budget SET daily_requests = daily_requests + 1,
        next_request_at = clock_timestamp() + $1 * interval '1 millisecond' WHERE provider = 'openalex'`, [this.limits.pacingMs]);
      return { allowed: true, nextRunAt: null };
    });
  }

  async commit(job: LeasedGraphJob, input: PageCommit): Promise<GraphJob> {
    boundedJson(input, 12 * 1024 * 1024, 'Page');
    const page = pageSchema.parse(input);
    const checkpoint = boundedJson({ version: 1, ...page.checkpoint }, 2097152, 'Checkpoint');
    let result: string | null = null;
    if (page.result) {
      if (page.state !== 'completed') throw new Error('A graph result requires a completed job');
      if (page.result.meta.provider && page.result.meta.provider !== 'openalex') throw new Error('Graph jobs only support OpenAlex');
      for (const paper of [...page.result.nodes, ...page.result.prior, ...page.result.derivative]) oaPaperSchema.parse(paper);
      result = boundedJson({ version: 1, graph: { ...page.result, meta: { ...page.result.meta, provider: 'openalex' } } }, 4194304, 'Result');
    } else if (page.state === 'completed') throw new Error('A completed job requires a graph result');
    return this.transaction(async client => {
      // All quota mutations take this lock before job locks, including retention.
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [RESOURCE_LOCK]);
      const row = await this.lockedJob(client, job);
      if (page.requestUsed && !row.request_reserved) throw new Error('Upstream request was not reserved');
      if (page.result && JSON.stringify([...page.result.origins].sort()) !== JSON.stringify(row.origins)) throw new Error('Graph result origins do not match the job');
      await this.prune(client);
      const sources = [...new Map(page.papers.map(paper => [paper.id, paper])).values()];
      const old = await client.query(`SELECT p.id, p.metadata_bytes,
        (SELECT count(*)::integer FROM openpapers.job_references r WHERE r.job_id = p.job_id AND r.source = p.id) AS refs
        FROM openpapers.job_papers p WHERE p.job_id = $1 AND p.id = ANY($2::text[])`, [row.id, sources.map(p => p.id)]);
      const previous = new Map<string, Row>(old.rows.map(p => [p.id, p]));
      const totals = await client.query(`SELECT coalesce(sum(reference_count), 0)::integer AS refs,
        coalesce(sum(metadata_bytes), 0)::bigint AS bytes FROM openpapers.graph_jobs`);
      let acquired = row.acquired_count as number;
      let references = row.reference_count as number;
      let bytes = row.metadata_bytes as number;
      let totalRefs = totals.rows[0].refs as number;
      let totalBytes = Number(totals.rows[0].bytes);
      let stop: string | undefined;
      const admitted: { id: string; metadata: unknown; metadata_bytes: number; references: string[] }[] = [];
      for (const paper of sources) {
        const existing = previous.get(paper.id);
        const { id, references: incoming, ...metadata } = paper;
        const refs = [...new Set(incoming)];
        const stored = { version: 1, ...metadata };
        const size = Buffer.byteLength(boundedJson(stored, 262144, 'Paper metadata'));
        const refDelta = refs.length - (existing?.refs ?? 0);
        const byteDelta = size - (existing?.metadata_bytes ?? 0);
        if (!existing && acquired >= row.candidate_budget) { stop ??= 'candidate_budget'; continue; }
        if (references + refDelta > row.reference_budget) { stop ??= 'reference_budget'; continue; }
        if (totalRefs + refDelta > this.limits.totalReferenceBudget) { stop ??= 'total_reference_budget'; continue; }
        if (totalBytes + byteDelta > this.limits.totalMetadataBytes) { stop ??= 'storage_budget'; continue; }
        admitted.push({ id, metadata: stored, metadata_bytes: size, references: refs });
        acquired += existing ? 0 : 1;
        references += refDelta; totalRefs += refDelta; bytes += byteDelta; totalBytes += byteDelta;
      }
      if (admitted.length) {
        const data = JSON.stringify(admitted);
        await client.query(`INSERT INTO openpapers.job_papers (job_id, id, metadata, metadata_bytes, fetched_at)
          SELECT $1, p.id, p.metadata, p.metadata_bytes, $3::timestamptz
          FROM jsonb_to_recordset($2::jsonb) AS p(id text, metadata jsonb, metadata_bytes integer)
          ON CONFLICT (job_id, id) DO UPDATE SET metadata = EXCLUDED.metadata,
            metadata_bytes = EXCLUDED.metadata_bytes, fetched_at = EXCLUDED.fetched_at`, [row.id, data, page.fetchedAt]);
        await client.query('DELETE FROM openpapers.job_references WHERE job_id = $1 AND source = ANY($2::text[])', [row.id, admitted.map(p => p.id)]);
        await client.query(`INSERT INTO openpapers.job_references (job_id, source, target)
          SELECT $1, p.id, r.target FROM jsonb_to_recordset($2::jsonb) AS p(id text, "references" jsonb)
          CROSS JOIN LATERAL jsonb_array_elements_text(p."references") AS r(target)`, [row.id, data]);
      }
      if (row.phase === 'acquire' && acquired >= row.candidate_budget) stop ??= 'candidate_budget';
      if (row.phase === 'acquire' && references >= row.reference_budget) stop ??= 'reference_budget';
      const terminal = page.state === 'completed' || page.state === 'failed';
      let state = terminal ? page.state : stop ? 'queued' : page.state ?? 'queued';
      const phase = page.state === 'completed' ? 'publish' : stop && !terminal ? 'score' : page.phase ?? row.phase;
      let next = terminal || stop ? null : page.nextRunAt ?? null;
      if (state === 'paused' && !next) throw new Error('A paused graph job requires a run time');
      if (state === 'paused' && next && Date.parse(next) <= Date.now()) { state = 'queued'; next = null; }
      // Explicit upstream backoff is independent of pacing, terminal state and phase.
      if (page.providerCooldownUntil) {
        await client.query(`INSERT INTO openpapers.provider_budget (provider, budget_day, daily_budget, cooldown_until)
          VALUES ('openalex', (clock_timestamp() AT TIME ZONE 'UTC')::date, $1, $2)
          ON CONFLICT (provider) DO UPDATE SET cooldown_until = greatest(provider_budget.cooldown_until, EXCLUDED.cooldown_until)`,
        [this.limits.dailyRequestBudget, page.providerCooldownUntil]);
      }
      const finalCheckpoint = stop && !terminal ? boundedJson({ version: 1, ...page.checkpoint, frontier: [] }, 2097152, 'Checkpoint') : checkpoint;
      const { rows } = await client.query(`UPDATE openpapers.graph_jobs SET acquired_count = $3, reference_count = $4,
        metadata_bytes = $5, checkpoint = $6::jsonb, state = $7, phase = $8, next_run_at = $9,
        stop_reason = $10, error = $11, result = $12::jsonb, lease_token = NULL, lease_expires_at = NULL,
        request_reserved = false, updated_at = clock_timestamp()
        WHERE id = $1 AND lease_token = $2 AND lease_expires_at > clock_timestamp() RETURNING *`,
      [row.id, job.leaseToken, acquired, references, bytes, finalCheckpoint, state, phase, next,
        stop ?? page.stopReason ?? row.stop_reason, page.error === undefined ? row.error : page.error, result]);
      if (!rows.length) throw new Error('Graph job lease is stale or expired');
      const value = publicJob(rows[0]);
      if (terminal) await this.prune(client);
      return value;
    });
  }

  async papers(job: LeasedGraphJob, signal?: AbortSignal): Promise<Paper[]> {
    const deadline = Date.now() + 30000;
    return this.transaction(async client => {
      const row = await this.lockedJob(client, job);
      const readDeadline = Math.min(deadline, row.lease_expires_at.getTime());
      const query = async (text: string, values: unknown[]) => {
        signal?.throwIfAborted();
        const remaining = readDeadline - Date.now();
        if (remaining <= 1000) throw new DOMException('Graph paper read timed out', 'TimeoutError');
        // Keep the server limit below the driver limit, with time to receive cancellation.
        const timeout = Math.min(20000, remaining - 1000);
        const settings: QueryConfig & { query_timeout: number } = {
          text: "SELECT set_config('statement_timeout', $1, true)", values: [`${timeout}ms`], query_timeout: Math.min(25000, remaining),
        };
        await client.query(settings);
        signal?.throwIfAborted();
        const left = readDeadline - Date.now();
        if (left <= 1000) throw new DOMException('Graph paper read timed out', 'TimeoutError');
        const config: QueryConfig & { query_timeout: number } = { text, values, query_timeout: Math.min(25000, left) };
        const result = await client.query(config);
        signal?.throwIfAborted();
        return result;
      };
      const papers: Paper[] = [];
      let cursor = '';
      let references = 0;
      // Keyset batches bound driver buffers; the interface still requires the final Paper[].
      while (true) {
        const { rows } = await query(`SELECT p.id, p.metadata,
          coalesce((SELECT jsonb_agg(r.target ORDER BY r.target) FROM openpapers.job_references r
            WHERE r.job_id = p.job_id AND r.source = p.id), '[]'::jsonb) AS references
          FROM openpapers.job_papers p WHERE p.job_id = $1 AND p.id > $2 ORDER BY p.id LIMIT $3`, [row.id, cursor, PAPER_READ_BATCH]);
        if (!rows.length) break;
        for (const stored of rows) {
          signal?.throwIfAborted();
          if (Date.now() >= readDeadline) throw new DOMException('Graph paper read timed out', 'TimeoutError');
          if (stored.id <= cursor) throw new Error('Stored graph paper IDs are not unique and ordered');
          z.literal(1).parse(stored.metadata.version);
          const paper = oaPaperSchema.parse({ ...stored.metadata, id: stored.id, references: stored.references });
          if (new Set(paper.references).size !== paper.references.length) throw new Error('Stored graph references are not unique');
          references += paper.references.length;
          papers.push(paper);
          if (papers.length > row.candidate_budget || references > row.reference_budget) throw new Error('Stored graph exceeds its resource budget');
          cursor = paper.id;
        }
        if (rows.length < PAPER_READ_BATCH) break;
      }
      if (papers.length !== row.acquired_count || references !== row.reference_count) throw new Error('Stored graph counts are inconsistent');
      if (Date.now() >= readDeadline) throw new DOMException('Graph paper read timed out', 'TimeoutError');
      await query(`SELECT id FROM openpapers.graph_jobs WHERE id = $1 AND lease_token = $2
        AND state = 'running' AND lease_expires_at > clock_timestamp() FOR UPDATE`, [row.id, job.leaseToken])
        .then(({ rows }) => { if (!rows.length) throw new Error('Graph job lease is stale or expired'); });
      return papers;
    }, signal);
  }

  close(): Promise<void> {
    return this.closing ??= this.ready.catch(() => {}).then(() => this.pool.end());
  }
}

// The executable worker uses this name; both entry points share the same durable store.
export { PostgresGraphStore as PostgresGraphJobStore };
