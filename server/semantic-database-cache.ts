import { createHash } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import { z } from 'zod';
import { PersistentCache } from './cache.ts';
import { graphPostgresPoolConfig } from './postgres-store.ts';

const ENTRY_BYTES = 4 * 1024 * 1024;
const TOTAL_BYTES = 32 * 1024 * 1024;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const DATABASE_TIMEOUT_MS = 5000;
const hash = (key: string) => createHash('sha256').update(key).digest('hex');
const timestamp = z.union([z.date(), z.string().max(100).datetime({ offset: true })])
  .transform(value => new Date(value).getTime()).refine(value => Number.isFinite(value) && value > 0);
const rowSchema = z.object({
  key_hash: z.string().regex(/^[0-9a-f]{64}$/),
  cache_key: z.string().min(4).max(1000).startsWith('s2:').regex(/^[^\x00-\x1f\x7f]+$/),
  stored_at: timestamp, expires_at: timestamp,
  payload: z.object({ version: z.literal(1), value: z.unknown() }).strict(),
  byte_count: z.number().int().positive().max(ENTRY_BYTES),
});

function entry<T>(row: unknown) {
  const parsed = rowSchema.safeParse(row);
  if (!parsed.success) return undefined;
  const r = parsed.data;
  if (r.key_hash !== hash(r.cache_key) || r.payload.value === undefined ||
      r.stored_at > Date.now() + 60000 || r.expires_at <= Date.now() - RETENTION_MS) return undefined;
  const result = { key: r.cache_key, storedAt: new Date(r.stored_at).toISOString(),
    expiresAt: r.expires_at, value: r.payload.value as T };
  if (Buffer.byteLength(JSON.stringify(result)) > r.byte_count) return undefined;
  return result;
}

/** Best-effort S2 durability; provider schemas still validate raw and normalized values. */
export class PersistentSemanticCache extends PersistentCache {
  private pool?: pg.Pool;

  constructor(directory: string, private databaseUrl: string) { super(directory); }

  private async database<T>(operation: (client: PoolClient) => Promise<T>): Promise<T | undefined> {
    const deadline = AbortSignal.timeout(DATABASE_TIMEOUT_MS);
    let client: PoolClient | undefined;
    let destroyed = false;
    const cancel = () => { if (client && !destroyed) { destroyed = true; client.release(true); } };
    try {
      if (!this.pool) {
        this.pool = new pg.Pool({
          ...graphPostgresPoolConfig(this.databaseUrl, { max: 1, ca: process.env.GRAPH_DATABASE_CA }),
          connectionTimeoutMillis: DATABASE_TIMEOUT_MS, query_timeout: DATABASE_TIMEOUT_MS,
          statement_timeout: DATABASE_TIMEOUT_MS, lock_timeout: DATABASE_TIMEOUT_MS,
          idle_in_transaction_session_timeout: DATABASE_TIMEOUT_MS,
          application_name: 'openpapers-semantic-cache', allowExitOnIdle: true,
        });
        this.pool.on('error', () => {});
      }
      client = await new Promise<PoolClient>((resolve, reject) => {
        const abort = () => reject(deadline.reason);
        deadline.addEventListener('abort', abort, { once: true });
        this.pool!.connect((error, connected, release) => {
          deadline.removeEventListener('abort', abort);
          if (deadline.aborted) { release?.(true); reject(deadline.reason); }
          else if (error) reject(error);
          else resolve(connected!);
        });
      });
      deadline.addEventListener('abort', cancel, { once: true });
      deadline.throwIfAborted();
      await client.query('BEGIN');
      const result = await operation(client);
      deadline.throwIfAborted();
      await client.query('COMMIT');
      deadline.throwIfAborted();
      return result;
    } catch (error) {
      // Closing a timed-out connection also rolls back SQL the driver did not cancel.
      cancel();
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      console.warn('Semantic cache database unavailable:',
        typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'UnknownError');
      return undefined;
    } finally {
      deadline.removeEventListener('abort', cancel);
      if (client && !destroyed) client.release();
    }
  }

  override async get<T>(key: string, stale = false) {
    const local = await super.get<T>(key);
    if (local || !key.startsWith('s2:') || key.length > 1000 || /[\x00-\x1f\x7f]/.test(key)) {
      return local ?? (stale ? super.get<T>(key, true) : undefined);
    }
    const rows = await this.database(async client => (await client.query(`SELECT
      key_hash, cache_key, stored_at, expires_at, payload, byte_count
      FROM openpapers.semantic_cache WHERE key_hash = $1 AND cache_key = $2
        AND expires_at > clock_timestamp() - interval '24 hours'
        AND ($3::boolean OR expires_at > clock_timestamp())`, [hash(key), key, stale])).rows);
    const durable = rows?.length === 1 ? entry<T>(rows[0]) : undefined;
    if (durable?.key === key && (stale || durable.expiresAt > Date.now())) return durable;
    return stale ? super.get<T>(key, true) : undefined;
  }

  override async list<T>(prefix: string) {
    const local = await super.list<T>(prefix);
    if (!prefix.startsWith('s2:') || prefix.length > 1000 || /[\x00-\x1f\x7f]/.test(prefix)) return local;
    const rows = await this.database(async client => (await client.query(`SELECT
      key_hash, cache_key, stored_at, expires_at, payload, byte_count
      FROM openpapers.semantic_cache WHERE starts_with(cache_key, $1)
        AND expires_at > clock_timestamp() - interval '24 hours'
      ORDER BY stored_at DESC, key_hash LIMIT 128`, [prefix])).rows);
    const merged = new Map<string, (typeof local)[number]>();
    // Merge without re-setting entries: neither reads nor restarts renew provenance/TTL.
    const candidates = [...local, ...(rows ?? []).flatMap(row => {
      const parsed = entry<T>(row);
      return parsed && parsed.key.startsWith(prefix) ? [parsed] : [];
    })].sort((a, b) => Date.parse(b.storedAt) - Date.parse(a.storedAt));
    let bytes = 2;
    for (const candidate of candidates) {
      if (merged.has(candidate.key) || candidate.expiresAt <= Date.now() - RETENTION_MS) continue;
      const size = Buffer.byteLength(JSON.stringify(candidate)) + 1;
      if (bytes + size > TOTAL_BYTES) continue;
      merged.set(candidate.key, candidate); bytes += size;
      if (merged.size === 128) break;
    }
    return [...merged.values()];
  }

  override async set<T>(key: string, value: T, ttlMs = RETENTION_MS) {
    await super.set(key, value, ttlMs);
    if (!key.startsWith('s2:') || key.length > 1000 || /[\x00-\x1f\x7f]/.test(key)) return;
    const stored = await super.get<T>(key, true);
    if (!stored || !Number.isFinite(new Date(stored.expiresAt).getTime()) || stored.expiresAt <= Date.now() - RETENTION_MS) return;
    const payload = JSON.stringify({ version: 1, value: stored.value });
    if (Buffer.byteLength(payload) + Buffer.byteLength(key) + 256 > ENTRY_BYTES) return;
    await this.database(async client => {
      await client.query('SELECT pg_advisory_xact_lock(764521340004)');
      await client.query(`INSERT INTO openpapers.semantic_cache
        (key_hash, cache_key, stored_at, expires_at, payload, byte_count)
        SELECT $1, $2, $3::timestamptz, $4::timestamptz, $5::jsonb,
          octet_length(($5::jsonb)::text) + octet_length($2::text) + 256
        WHERE octet_length(($5::jsonb)::text) + octet_length($2::text) + 256 <= 4194304
        ON CONFLICT (key_hash) DO UPDATE SET cache_key = EXCLUDED.cache_key,
          stored_at = EXCLUDED.stored_at, expires_at = EXCLUDED.expires_at,
          payload = EXCLUDED.payload, byte_count = EXCLUDED.byte_count
        WHERE semantic_cache.cache_key = EXCLUDED.cache_key AND semantic_cache.stored_at < EXCLUDED.stored_at`,
      [hash(key), key, stored.storedAt, new Date(stored.expiresAt).toISOString(), payload]);
    });
  }

  async close() { await this.pool?.end(); }
}
