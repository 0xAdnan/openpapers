import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface Entry<T> {
  key: string;
  storedAt: string;
  expiresAt: number;
  value: T;
}

/** Outage fallbacks never serve data fetched longer ago than this, however it is labelled. */
export const MAX_STALE_MS = 30 * 24 * 60 * 60 * 1000;

/** Readable age of data fetched at `fetchedAt`, or undefined when it is undated or too old for an outage fallback. */
export function staleAge(fetchedAt: string, now = Date.now()): string | undefined {
  const age = now - Date.parse(fetchedAt);
  if (!Number.isFinite(age) || age < -60000 || age > MAX_STALE_MS) return undefined;
  const hours = Math.max(0, Math.floor(age / 3600000));
  if (hours < 1) return 'less than an hour old';
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'} old`;
  return `${Math.floor(hours / 24)} days old`;
}

// One bounded file, atomically replaced; keys never become filesystem paths.
export class PersistentCache {
  private entries = new Map<string, Entry<unknown>>();
  private pending = new Map<string, { operation: Promise<unknown>; controller: AbortController; consumers: number }>();
  private writes = Promise.resolve();
  private readonly ready: Promise<void>;

  constructor(private directory: string, private maxEntries = 128, private maxBytes = 24 * 1024 * 1024) {
    this.ready = this.load();
  }

  private async load() {
    try {
      const file = join(this.directory, 'openalex-cache-v1.json');
      if ((await stat(file)).size > this.maxBytes) return;
      const rows: Entry<unknown>[] = JSON.parse(await readFile(file, 'utf8'));
      if (!Array.isArray(rows)) return;
      for (const row of rows.slice(-this.maxEntries)) {
        if (typeof row?.key === 'string' && row.key.length <= 1000 &&
            typeof row.storedAt === 'string' && Number.isFinite(Date.parse(row.storedAt)) &&
            Number.isFinite(row.expiresAt) && row.value !== undefined) {
          this.entries.set(row.key, row);
        }
      }
    } catch {
      // A missing, corrupted or unwritable cache must not break bundled data.
    }
  }

  async get<T>(key: string, stale = false): Promise<Entry<T> | undefined> {
    await this.ready;
    const entry = this.entries.get(key);
    if (!entry || (!stale && entry.expiresAt <= Date.now())) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry as Entry<T>;
  }

  async list<T>(prefix: string): Promise<Entry<T>[]> {
    await this.ready;
    return [...this.entries.values()].filter(e => e.key.startsWith(prefix)) as Entry<T>[];
  }

  async set<T>(key: string, value: T, ttlMs = 24 * 60 * 60 * 1000) {
    await this.ready;
    const entry: Entry<T> = { key, value, storedAt: new Date().toISOString(), expiresAt: Date.now() + ttlMs };
    if (Buffer.byteLength(JSON.stringify(entry)) > this.maxBytes / 2) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    let rows = [...this.entries.values()];
    let body = JSON.stringify(rows);
    while (Buffer.byteLength(body) > this.maxBytes && rows.length) {
      this.entries.delete(rows[0].key);
      rows = rows.slice(1);
      body = JSON.stringify(rows);
    }
    this.writes = this.writes.then(async () => {
      const temporary = join(this.directory, `${createHash('sha256').update(body).digest('hex').slice(0, 12)}-${randomUUID()}.tmp`);
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await writeFile(temporary, body, { mode: 0o600 });
        await rename(temporary, join(this.directory, 'openalex-cache-v1.json'));
      } catch {
        await unlink(temporary).catch(() => {});
      }
    });
    await this.writes;
  }

  async deduplicate<T>(key: string, task: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    let pending = this.pending.get(key);
    if (pending?.controller.signal.aborted) throw pending.controller.signal.reason;
    if (!pending) {
      if (this.pending.size >= 32) throw new Error('Request queue is full');
      const controller = new AbortController();
      const operation = Promise.resolve().then(() => task(controller.signal));
      pending = { operation, controller, consumers: 0 };
      this.pending.set(key, pending);
      const cleanup = () => { this.pending.delete(key); };
      void operation.then(cleanup, cleanup);
    }
    const shared = pending;
    shared.consumers++;
    let detached = false;
    const detach = () => {
      if (detached) return;
      detached = true;
      if (--shared.consumers === 0) shared.controller.abort(signal?.reason);
    };
    signal?.addEventListener('abort', detach, { once: true });
    try {
      // Do not free admission slots by racing a cancellation against ongoing work.
      const result = await shared.operation as T;
      signal?.throwIfAborted();
      return result;
    } finally {
      signal?.removeEventListener('abort', detach);
      detach();
    }
  }
}
