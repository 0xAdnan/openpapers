import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg, { type PoolClient } from 'pg';
import { graphPostgresPoolConfig } from './postgres-store.ts';

export const S2_PACING_MS = 1250;
const LEASE_MS = 30000;
const DATABASE_TIMEOUT_MS = 5000;
const MAX_KEYS = 100;
const MAX_WAITING = 16;
const MAX_COOLDOWN_SECONDS = 86400;

export class SemanticRateLimitError extends Error {
  constructor(public status: 429 | 503, message: string, public retryAfter?: number) { super(message); }
}

export function semanticRetryAfter(header: string | null, now = Date.now()): number {
  const seconds = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header)
    : header ? (Date.parse(header) - now) / 1000 : 0;
  return Math.ceil(Math.min(MAX_COOLDOWN_SECONDS, Math.max(60, Number.isNaN(seconds) ? 0 : seconds)));
}

export interface SemanticRateReservation {
  /** Check again immediately before fetch, including after a suspended instance resumes. */
  assertValid(): void;
  cooldown?(retryAfter: number, signal: AbortSignal): Promise<void>;
  release(retryAfter?: number, signal?: AbortSignal): Promise<void>;
}

export interface SemanticRateLimiter {
  reserve(signal: AbortSignal): Promise<SemanticRateReservation>;
}

type GateState = { active: boolean; waiting: (() => void)[]; nextRequestAt: number; cooldownUntil: number };
const keyedStates = new Map<string, GateState>();
const newState = (): GateState => ({ active: false, waiting: [], nextRequestAt: 0, cooldownUntil: 0 });
let databasePool: { identity: string; pool: pg.Pool } | undefined;

function poolFor(databaseUrl: string): pg.Pool {
  const identity = createHash('sha256').update(databaseUrl).digest('hex');
  if (databasePool) {
    if (databasePool.identity !== identity) throw new Error('Semantic Scholar database configuration changed');
    return databasePool.pool;
  }
  const pool = new pg.Pool({
    ...graphPostgresPoolConfig(databaseUrl, { max: 1, ca: process.env.GRAPH_DATABASE_CA }),
    connectionTimeoutMillis: DATABASE_TIMEOUT_MS, query_timeout: DATABASE_TIMEOUT_MS,
    statement_timeout: DATABASE_TIMEOUT_MS, lock_timeout: DATABASE_TIMEOUT_MS,
    idle_in_transaction_session_timeout: DATABASE_TIMEOUT_MS,
    application_name: 'openpapers-semantic-budget', allowExitOnIdle: true,
  });
  pool.on('error', () => {});
  databasePool = { identity, pool };
  return pool;
}

async function transaction<T>(databaseUrl: string, signal: AbortSignal, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(DATABASE_TIMEOUT_MS)]);
  deadline.throwIfAborted();
  const pool = poolFor(databaseUrl);
  const client = await new Promise<PoolClient>((resolve, reject) => {
    const cancel = () => reject(deadline.reason);
    deadline.addEventListener('abort', cancel, { once: true });
    pool.connect((error, client, release) => {
      deadline.removeEventListener('abort', cancel);
      if (deadline.aborted) { release?.(true); reject(deadline.reason); }
      else if (error) reject(error);
      else resolve(client!);
    });
  });
  let destroyed = false;
  // Driver timeouts do not cancel SQL. Close the connection rather than recycling it.
  const cancel = () => { destroyed = true; client.release(true); };
  deadline.addEventListener('abort', cancel, { once: true });
  try {
    deadline.throwIfAborted();
    await client.query('BEGIN');
    const result = await fn(client);
    deadline.throwIfAborted();
    await client.query('COMMIT');
    deadline.throwIfAborted();
    return result;
  } catch (error) {
    if (!destroyed) { destroyed = true; client.release(true); }
    throw error;
  } finally {
    deadline.removeEventListener('abort', cancel);
    if (!destroyed) client.release();
  }
}

export class GlobalS2RateLimiter implements SemanticRateLimiter {
  private readonly localState = newState();

  constructor(private options: { keyHash?: string; databaseUrl?: string; unavailable?: boolean; now?: () => number } = {}) {}

  async reserve(signal: AbortSignal): Promise<SemanticRateReservation> {
    signal.throwIfAborted();
    const now = this.options.now ?? Date.now;
    if (this.options.unavailable) throw new SemanticRateLimitError(503, 'Semantic Scholar shared rate gate is unavailable');
    let state = this.localState;
    if (this.options.keyHash) {
      const existing = keyedStates.get(this.options.keyHash);
      if (existing) state = existing;
      else {
        if (keyedStates.size >= MAX_KEYS) {
          const idle = [...keyedStates].find(([, entry]) => !entry.active && !entry.waiting.length
            && Math.max(entry.nextRequestAt, entry.cooldownUntil) <= now());
          if (!idle) throw new SemanticRateLimitError(503, 'Semantic Scholar rate gate key capacity is full');
          keyedStates.delete(idle[0]);
        }
        keyedStates.set(this.options.keyHash, state);
      }
    }
    if (state.active) {
      if (state.waiting.length >= MAX_WAITING) throw new SemanticRateLimitError(503, 'Semantic Scholar request queue is full');
      await new Promise<void>((resolve, reject) => {
        const grant = () => { signal.removeEventListener('abort', cancel); resolve(); };
        const cancel = () => {
          const index = state.waiting.indexOf(grant);
          if (index >= 0) state.waiting.splice(index, 1);
          reject(signal.reason);
        };
        state.waiting.push(grant);
        signal.addEventListener('abort', cancel, { once: true });
      });
    } else state.active = true;
    const unlock = () => { const next = state.waiting.shift(); if (next) next(); else state.active = false; };
    let token: string | undefined;
    let validUntil = Infinity;
    const databaseUrl = this.options.databaseUrl;
    try {
      while (true) {
        signal.throwIfAborted();
        if (state.cooldownUntil > now()) throw new SemanticRateLimitError(429,
          'Semantic Scholar rate limit cooldown; try later', Math.ceil((state.cooldownUntil - now()) / 1000));
        const wait = state.nextRequestAt - now();
        if (wait <= 0) break;
        await delay(wait, undefined, { signal });
      }
      if (databaseUrl) {
        token = randomUUID();
        while (true) {
          signal.throwIfAborted();
          const started = performance.now();
          const claim = await transaction(databaseUrl, signal, async client => {
            await client.query(`INSERT INTO openpapers.semantic_api_budget (key_hash)
              VALUES ($1) ON CONFLICT DO NOTHING`, [this.options.keyHash]);
            const { rows } = await client.query<{ lease_ms: number }>(`UPDATE openpapers.semantic_api_budget
              SET leased_slot_token = $2, lease_until = clock_timestamp() + $3 * interval '1 millisecond',
                next_request_at = clock_timestamp() + $4 * interval '1 millisecond'
              WHERE key_hash = $1 AND next_request_at <= clock_timestamp()
                AND (cooldown_until IS NULL OR cooldown_until <= clock_timestamp())
                AND (lease_until IS NULL OR lease_until <= clock_timestamp())
              RETURNING EXTRACT(EPOCH FROM (lease_until - clock_timestamp())) * 1000 AS lease_ms`,
            [this.options.keyHash, token, LEASE_MS, LEASE_MS + S2_PACING_MS]);
            if (rows.length) return { claimed: true, leaseMs: Number(rows[0].lease_ms), cooldownMs: 0, waitMs: 0 };
            const busy = await client.query<{ cooldown_ms: number; wait_ms: number }>(`SELECT
              GREATEST(0, EXTRACT(EPOCH FROM (cooldown_until - clock_timestamp())) * 1000) AS cooldown_ms,
              GREATEST(0, EXTRACT(EPOCH FROM (GREATEST(next_request_at, lease_until) - clock_timestamp())) * 1000) AS wait_ms
              FROM openpapers.semantic_api_budget WHERE key_hash = $1`, [this.options.keyHash]);
            if (!busy.rows.length) throw new Error('Semantic Scholar budget is missing');
            return { claimed: false, leaseMs: 0, cooldownMs: Number(busy.rows[0].cooldown_ms), waitMs: Number(busy.rows[0].wait_ms) };
          });
          if (claim.claimed) {
            // Leave room for the entire 12-second transport even after a delayed resume.
            validUntil = started + claim.leaseMs - 12000 - S2_PACING_MS;
            break;
          }
          if (claim.cooldownMs > 0) {
            state.cooldownUntil = Math.max(state.cooldownUntil, now() + claim.cooldownMs);
            throw new SemanticRateLimitError(429, 'Semantic Scholar rate limit cooldown; try later', Math.ceil(claim.cooldownMs / 1000));
          }
          await delay(Math.max(500, Math.min(1000, Math.ceil(claim.waitMs))), undefined, { signal });
        }
      }
      signal.throwIfAborted();
    } catch (error) {
      unlock();
      if (signal.aborted) throw signal.reason;
      if (error instanceof SemanticRateLimitError) throw error;
      throw new SemanticRateLimitError(503, 'Semantic Scholar shared rate gate is unavailable');
    }
    let released = false;
    return {
      assertValid() {
        signal.throwIfAborted();
        if (released || performance.now() >= validUntil) throw new SemanticRateLimitError(503, 'Semantic Scholar rate lease expired');
      },
      cooldown: async (retryAfter, cooldownSignal) => {
        const seconds = Math.min(MAX_COOLDOWN_SECONDS, Math.max(60,
          Number.isFinite(retryAfter) ? retryAfter : MAX_COOLDOWN_SECONDS));
        state.cooldownUntil = Math.max(state.cooldownUntil, now() + seconds * 1000);
        if (databaseUrl && token) {
          try {
            await transaction(databaseUrl, cooldownSignal, async client => {
              const result = await client.query(`UPDATE openpapers.semantic_api_budget
                SET cooldown_until = GREATEST(cooldown_until, clock_timestamp() + $3 * interval '1 second')
                WHERE key_hash = $1 AND leased_slot_token = $2`, [this.options.keyHash, token, seconds]);
              if (result.rowCount !== 1) throw new Error('Semantic Scholar rate lease was lost');
            });
          } catch {
            throw new SemanticRateLimitError(503, 'Semantic Scholar shared rate gate is unavailable');
          }
        }
      },
      release: async (retryAfter, releaseSignal = AbortSignal.timeout(DATABASE_TIMEOUT_MS)) => {
        if (released) return;
        released = true;
        const cooldown = retryAfter === undefined ? 0 : Math.min(MAX_COOLDOWN_SECONDS,
          Math.max(60, Number.isFinite(retryAfter) ? retryAfter : MAX_COOLDOWN_SECONDS));
        state.cooldownUntil = Math.max(state.cooldownUntil, now() + cooldown * 1000);
        try {
          if (databaseUrl && token) {
            // Cleanup is independent of consumer cancellation, but still deadline-bounded.
            await transaction(databaseUrl, releaseSignal, async client => {
              const result = await client.query(`UPDATE openpapers.semantic_api_budget
                SET leased_slot_token = NULL, lease_until = NULL,
                  next_request_at = clock_timestamp() + $3 * interval '1 millisecond',
                  cooldown_until = GREATEST(cooldown_until, clock_timestamp() + $4 * interval '1 second')
                WHERE key_hash = $1 AND leased_slot_token = $2`, [this.options.keyHash, token, S2_PACING_MS, cooldown]);
              if (result.rowCount !== 1) throw new Error('Semantic Scholar rate lease was lost');
            });
          }
        } catch {
          throw new SemanticRateLimitError(503, 'Semantic Scholar shared rate gate is unavailable');
        } finally {
          // No accumulated slots: the next request waits from actual completion, not reservation time.
          state.nextRequestAt = now() + S2_PACING_MS;
          unlock();
        }
      },
    };
  }
}

export function createSemanticRateLimiter(options: {
  apiKey?: string; databaseUrl?: string; fetch?: typeof fetch; offline?: boolean; now?: () => number;
}): SemanticRateLimiter {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  const liveKey = !!options.apiKey && !options.fetch && !options.offline;
  return new GlobalS2RateLimiter({
    keyHash: options.apiKey ? createHash('sha256').update(options.apiKey).digest('hex') : undefined,
    databaseUrl: liveKey ? databaseUrl : undefined,
    unavailable: liveKey && !!process.env.VERCEL && !databaseUrl,
    now: options.now,
  });
}
