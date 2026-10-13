import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PersistentCache } from './cache.ts';
import { ApiError, PaperService } from './service.ts';
import { SemanticService } from './semantic-service.ts';
import { PAPER_ID_PATTERN, paperProvider, providerName, type ProviderId } from '../shared/providers.ts';
import { GraphJobRunner } from './graph-jobs.ts';
import { PostgresGraphStore } from './postgres-store.ts';
import type { GraphJobStore } from './graph-store.ts';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { OpenAlexProvider } from './openalex.ts';

export function createApp(options: { service?: PaperService; semanticService?: SemanticService; defaultProvider?: ProviderId; offline?: boolean; rateLimit?: number; distPath?: string; requestTimeoutMs?: number; cacheDirectory?: string; snapshotPath?: string; maxResponseBytes?: number; jobStore?: GraphJobStore; jobRunner?: GraphJobRunner; background?: (task: Promise<unknown>) => void } = {}) {
  const offline = options.offline ?? /^(1|true)$/i.test(process.env.OFFLINE ?? '');
  const cache = new PersistentCache(options.cacheDirectory ?? fileURLToPath(new URL('../.cache/', import.meta.url)));
  const service = options.service ?? new PaperService(cache, offline, undefined, options.snapshotPath);
  const semanticService = options.semanticService ?? new SemanticService(cache, offline);
  const jobStore = options.jobStore ?? (process.env.DATABASE_URL && !offline ? new PostgresGraphStore() : undefined);
  const jobRunner = options.jobRunner ?? (jobStore ? new GraphJobRunner(jobStore,
    new OpenAlexProvider({ cache, apiKey: process.env.PAPERS_API_KEY, maxRequests: 1500 })) : undefined);
  const background = options.background ?? ((task: Promise<unknown>) => { void task.catch(() => {}); });
  const candidateBudget = z.coerce.number().int().min(40).max(50000).parse(process.env.GRAPH_CANDIDATE_BUDGET ?? 5000);
  const requestBudget = z.coerce.number().int().min(1).max(1500).parse(process.env.GRAPH_REQUEST_BUDGET ?? 100);
  const configuredProvider = options.defaultProvider ?? process.env.DEFAULT_PROVIDER ?? 'openalex';
  if (configuredProvider !== 'openalex' && configuredProvider !== 'semantic-scholar') throw new Error('DEFAULT_PROVIDER must be openalex or semantic-scholar');
  const semanticSearchEnabled = Boolean(process.env.S2_API_KEY);
  const defaultProvider: ProviderId = configuredProvider === 'semantic-scholar' && !semanticSearchEnabled ? 'openalex' : configuredProvider;
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  app.set('trust proxy', false);
  app.use(helmet({ contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", 'https://www.googletagmanager.com', "'unsafe-inline'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'https://www.google-analytics.com', 'https://*.google-analytics.com', 'https://*.googletagmanager.com'],
    connectSrc: ["'self'", 'https://www.google-analytics.com', 'https://*.google-analytics.com', 'https://*.analytics.google.com', 'https://*.googletagmanager.com'],
    fontSrc: ["'self'"],
    objectSrc: ["'none'"],
    upgradeInsecureRequests: null,
  } } }));
  const clients = new Map<string, { count: number; reset: number }>();
  let active = 0;
  app.use('/api', (req, res, next) => {
    if (options.maxResponseBytes) {
      const json = res.json.bind(res);
      res.json = body => {
        if (Buffer.byteLength(JSON.stringify(body)) > options.maxResponseBytes!) {
          return json.call(res.status(413), { error: 'This graph exceeds the deployment response limit. Try a single origin or a smaller research neighborhood.' });
        }
        return json(body);
      };
    }
    res.set('Cache-Control', 'no-store');
    if (req.originalUrl.length > 2048) return res.status(414).json({ error: 'Request URL is too long' });
    const now = Date.now();
    for (const [key, row] of clients) if (row.reset <= now) clients.delete(key);
    const ip = req.ip ?? 'unknown';
    let row = clients.get(ip);
    if (!row) {
      if (clients.size >= 5000) return res.status(503).json({ error: 'Server is busy' });
      row = { count: 0, reset: now + 60000 };
      clients.set(ip, row);
    }
    if (++row.count > (options.rateLimit ?? 60)) {
      res.set('Retry-After', String(Math.ceil((row.reset - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests; try again shortly' });
    }
    if (active >= 16) return res.status(503).json({ error: 'Server is busy; try again shortly' });
    active++;
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      controller.abort(new ApiError(504, 'Request timed out; try again shortly'));
      if (!res.headersSent) res.status(504).json({ error: 'Request timed out; try again shortly' });
    }, options.requestTimeoutMs ?? 60000);
    deadline.unref();
    let released = false;
    const cancel = () => controller.abort(new ApiError(499, 'Request closed'));
    const release = () => {
      if (!released) { released = true; clearTimeout(deadline); res.removeListener('close', cancel); active--; }
    };
    res.locals.signal = controller.signal;
    res.locals.release = release;
    res.once('close', cancel);
    next();
  });
  const route = (handler: (req: Request, res: Response, signal: AbortSignal) => Promise<void>) =>
    async (req: Request, res: Response) => {
      try { await handler(req, res, res.locals.signal); }
      finally { res.locals.release(); }
    };
  const scalar = (value: unknown, name: string, max: number) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
      throw new ApiError(400, `Invalid ${name}`);
    }
    return value.trim();
  };
  const selector = (value: unknown, fallback: ProviderId): ProviderId => {
    if (value === undefined) return fallback;
    const selected = scalar(value, 'provider', 20);
    if (selected !== 'openalex' && selected !== 'semantic-scholar') throw new ApiError(400, 'Unknown search provider');
    return selected;
  };
  const providers = () => ({ defaultProvider, providers: [
    { id: 'openalex', name: 'OpenAlex', keyConfigured: Boolean(process.env.PAPERS_API_KEY), offline },
    ...(semanticSearchEnabled ? [{ id: 'semantic-scholar', name: 'Semantic Scholar', keyConfigured: true, offline }] : []),
  ] });
  app.get('/api/health', route(async (_req, res) => {
    await Promise.all([service.ready, semanticService.ready]);
    if (!res.writableEnded) res.json({ status: 'ok', provider: providerName(defaultProvider), offline });
  }));
  app.get('/api/providers', route(async (_req, res) => { if (!res.writableEnded) res.json(providers()); }));
  app.get('/api/graph-jobs/config', route(async (_req, res) => {
    let available = Boolean(jobStore && jobRunner);
    if (available) {
      try {
        await jobStore!.ready;
      } catch (err) {
        const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
        const name = err instanceof Error ? err.name : undefined;
        console.error('Graph database readiness failed:', typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code
          : typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name) ? name : 'UnknownError');
        available = false;
      }
    }
    if (!res.writableEnded) res.json({ available, candidateBudget, maxCandidateBudget: 50000, requestBudget,
      persistence: available ? 'postgres' : 'none' });
  }));
  const submitSchema = z.object({ origins: z.array(z.string().regex(/^W[1-9]\d{0,14}$/)).min(1).max(3),
    candidateBudget: z.number().int().min(40).max(50000).optional() }).strict();
  app.post('/api/graph-jobs', express.json({ limit: '2kb' }), route(async (req, res) => {
    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success || new Set(parsed.data.origins).size !== parsed.data.origins.length) throw new ApiError(400, 'Use 1 to 3 distinct origin papers and a candidate budget from 40 to 50,000');
    if (!jobStore || !jobRunner) throw new ApiError(503, 'Persistent graph jobs are not configured');
    const budget = Math.min(parsed.data.candidateBudget ?? candidateBudget, candidateBudget);
    const job = await jobStore.create(parsed.data.origins, budget, requestBudget);
    if (!res.writableEnded) res.status(job.state === 'completed' ? 200 : 202).json(job);
    if (job.state !== 'completed' && job.state !== 'failed') background(jobRunner.runStep(job.id).catch(() => {}));
  }));
  app.get('/api/graph-jobs/:id', route(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw new ApiError(400, 'Invalid graph job ID');
    if (!jobStore) throw new ApiError(503, 'Persistent graph jobs are not configured');
    const job = await jobStore.get(scalar(req.params.id, 'graph job ID', 36));
    if (!job) throw new ApiError(404, 'Graph job not found');
    if (!res.writableEnded) res.json(job);
  }));
  app.post('/api/internal/graph-worker', route(async (req, res) => {
    const secret = process.env.GRAPH_WORKER_TOKEN;
    const actual = req.get('authorization') ?? '';
    const expected = `Bearer ${secret ?? ''}`;
    if (!secret || Buffer.byteLength(actual) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
      throw new ApiError(401, 'Worker authentication required');
    }
    if (!jobRunner) throw new ApiError(503, 'Persistent graph jobs are not configured');
    const jobs = await jobRunner.runBatch(10, Date.now() + 40000);
    if (!res.writableEnded) res.json({ processedSteps: jobs.length });
  }));
  app.get('/api/examples', route(async (_req, res) => {
    const examples = await service.examples();
    if (!res.writableEnded) res.json(examples.map(example => ({ ...example, provider: 'openalex' })));
  }));
  app.get('/api/search', route(async (req, res, signal) => {
    const q = scalar(req.query.q, 'search query (1-200 characters)', 200);
    const raw = req.query.page === undefined ? '1' : scalar(req.query.page, 'page', 3);
    if (!/^[1-9]\d{0,2}$/.test(raw) || Number(raw) > 100) throw new ApiError(400, 'Page must be an integer from 1 to 100');
    const selected = selector(req.query.provider, defaultProvider);
    if (selected === 'semantic-scholar' && !semanticSearchEnabled) throw new ApiError(503, 'Semantic Scholar search is disabled until S2_API_KEY is configured.');
    const response = await (selected === 'semantic-scholar' ? semanticService : service).search(q, Number(raw), signal);
    if (!res.writableEnded && !res.destroyed) res.json({ ...response, meta: { ...response.meta, provider: selected } });
  }));
  app.get('/api/graph', route(async (req, res, signal) => {
    const raw = scalar(req.query.ids, 'origin IDs', 131);
    const ids = raw.split(',');
    if (!ids.length || ids.length > 3 || ids.some(id => !PAPER_ID_PATTERN.test(id)) || new Set(ids).size !== ids.length) {
      throw new ApiError(400, 'Use 1 to 3 distinct paper IDs from search results');
    }
    const selected = paperProvider(ids[0]);
    if (ids.some(id => paperProvider(id) !== selected)) throw new ApiError(400, 'Combined graph origins must use the same provider; cross-provider identities have not been reconciled');
    if (selector(req.query.provider, selected) !== selected) throw new ApiError(400, 'Provider does not match the graph paper IDs');
    const response = await (selected === 'semantic-scholar' ? semanticService : service).graph(ids, signal);
    if (!res.writableEnded && !res.destroyed) res.json({ ...response, meta: { ...response.meta, provider: selected } });
  }));
  app.get('/api/paper/:id', route(async (req, res, signal) => {
    const id = scalar(req.params.id, 'paper ID', 43);
    if (!PAPER_ID_PATTERN.test(id)) throw new ApiError(400, 'Invalid paper ID');
    const selected = paperProvider(id);
    if (selector(req.query.provider, selected) !== selected) throw new ApiError(400, 'Provider does not match the paper ID');
    const response = await (selected === 'semantic-scholar' ? semanticService : service).paper(id, signal);
    if (!res.writableEnded && !res.destroyed) res.json({ ...response, meta: { ...response.meta, provider: selected } });
  }));
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'API route not found' }); res.locals.release(); });
  const dist = options.distPath ?? fileURLToPath(new URL('../dist/', import.meta.url));
  if (existsSync(`${dist}/index.html`)) {
    app.use(express.static(dist, { index: false, dotfiles: 'deny', maxAge: '1h' }));
    app.get('/{*path}', (req, res, next) => {
      if (!req.accepts('html')) return next();
      res.set('Cache-Control', 'no-cache');
      res.sendFile(`${dist}/index.html`);
    });
  }
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    res.locals.release?.();
    if (res.destroyed) return;
    if (res.headersSent) return res.end();
    const known = error instanceof ApiError;
    if (!known && error?.status === 400) return res.status(400).json({ error: 'Invalid request encoding' });
    if (!known) console.error('API request failed:', error instanceof Error ? error.name : 'Unknown error');
    res.status(known ? error.status : 500).json({ error: known ? error.message : 'Request could not be completed' });
  };
  app.use(errors);
  return { app, service };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rawPort = process.env.PORT ?? '3001';
  if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) throw new Error('PORT must be 1-65535');
  const { app, service } = createApp();
  await service.ready;
  const host = process.env.HOST ?? '127.0.0.1';
  const server = app.listen(Number(rawPort), host, () => console.info(`OpenPapers backend listening on http://${host}:${rawPort}`));
  server.requestTimeout = 60000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
}
