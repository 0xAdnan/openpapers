import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PersistentCache } from './cache.ts';
import { GraphJobRunner } from './graph-jobs.ts';
import type { GraphJobStore } from './graph-store.ts';
import { OpenAlexProvider } from './openalex.ts';

export async function runWorker(store: GraphJobStore, runner: Pick<GraphJobRunner, 'runStep'>, signal: AbortSignal): Promise<void> {
  try {
    await store.ready;
    while (!signal.aborted) {
      let idle = false;
      try {
        const result = await runner.runStep(undefined, signal);
        idle = !result;
      } catch (error) {
        if (signal.aborted) break;
        console.error('Graph worker step failed:', error instanceof Error ? error.name : 'Unknown error');
        idle = true;
      }
      if (idle) {
        try { await delay(1000, undefined, { signal }); }
        catch (error) { if (!signal.aborted) throw error; }
      }
    }
  } finally {
    await store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stepMs = Number(process.env.GRAPH_WORKER_STEP_MS ?? 40_000);
  if (!Number.isInteger(stepMs) || stepMs < 1 || stepMs > 40_000) throw new Error('GRAPH_WORKER_STEP_MS must be 1-40000');
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Graph worker is shutting down'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  // Load deployment wiring only for the executable, never when importing worker helpers.
  const { PostgresGraphJobStore } = await import('./postgres-store.ts');
  const store = new PostgresGraphJobStore();
  const provider = new OpenAlexProvider({
    cache: new PersistentCache(fileURLToPath(new URL('../.cache/', import.meta.url))),
    apiKey: process.env.PAPERS_API_KEY, offline: /^(1|true)$/i.test(process.env.OFFLINE ?? ''),
    timeoutMs: 12_000, maxRequests: 1500,
  });
  try {
    await runWorker(store, new GraphJobRunner(store, provider, { stepMs }), controller.signal);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
