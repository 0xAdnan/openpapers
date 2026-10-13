import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PersistentCache } from './cache.ts';
import { ApiError, PaperService } from './service.ts';
import { SemanticService } from './semantic-service.ts';
import { PAPER_ID_PATTERN, paperProvider, providerName, type ProviderId } from '../shared/providers.ts';

export function createApp(options: { service?: PaperService; semanticService?: SemanticService; defaultProvider?: ProviderId; offline?: boolean; rateLimit?: number; distPath?: string; requestTimeoutMs?: number; cacheDirectory?: string; snapshotPath?: string; maxResponseBytes?: number } = {}) {
  const offline = options.offline ?? /^(1|true)$/i.test(process.env.OFFLINE ?? '');
  const cache = new PersistentCache(options.cacheDirectory ?? fileURLToPath(new URL('../.cache/', import.meta.url)));
  const service = options.service ?? new PaperService(cache, offline, undefined, options.snapshotPath);
  const semanticService = options.semanticService ?? new SemanticService(cache, offline);
  const configuredProvider = options.defaultProvider ?? process.env.DEFAULT_PROVIDER ?? 'openalex';
  if (configuredProvider !== 'openalex' && configuredProvider !== 'semantic-scholar') throw new Error('DEFAULT_PROVIDER must be openalex or semantic-scholar');
  const defaultProvider: ProviderId = configuredProvider;
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  app.set('trust proxy', false);
  app.use(helmet({ contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], fontSrc: ["'self'"], objectSrc: ["'none'"],
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
    if (selected !== 'openalex' && selected !== 'semantic-scholar') throw new ApiError(400, 'Provider must be openalex or semantic-scholar');
    return selected;
  };
  const providers = () => ({ defaultProvider, providers: [
    { id: 'openalex', name: 'OpenAlex', keyConfigured: Boolean(process.env.OPENALEX_API_KEY), offline },
    { id: 'semantic-scholar', name: 'Semantic Scholar', keyConfigured: Boolean(process.env.S2_API_KEY), offline },
  ] });
  app.get('/api/health', route(async (_req, res) => {
    await Promise.all([service.ready, semanticService.ready]);
    if (!res.writableEnded) res.json({ status: 'ok', provider: providerName(defaultProvider), offline });
  }));
  app.get('/api/providers', route(async (_req, res) => { if (!res.writableEnded) res.json(providers()); }));
  app.get('/api/examples', route(async (_req, res) => {
    const examples = await service.examples();
    if (!res.writableEnded) res.json(examples.map(example => ({ ...example, provider: 'openalex' })));
  }));
  app.get('/api/search', route(async (req, res, signal) => {
    const q = scalar(req.query.q, 'search query (1-200 characters)', 200);
    const raw = req.query.page === undefined ? '1' : scalar(req.query.page, 'page', 3);
    if (!/^[1-9]\d{0,2}$/.test(raw) || Number(raw) > 100) throw new ApiError(400, 'Page must be an integer from 1 to 100');
    const selected = selector(req.query.provider, defaultProvider);
    const response = await (selected === 'semantic-scholar' ? semanticService : service).search(q, Number(raw), signal);
    if (!res.writableEnded && !res.destroyed) res.json({ ...response, meta: { ...response.meta, provider: selected } });
  }));
  app.get('/api/graph', route(async (req, res, signal) => {
    const raw = scalar(req.query.ids, 'origin IDs', 131);
    const ids = raw.split(',');
    if (!ids.length || ids.length > 3 || ids.some(id => !PAPER_ID_PATTERN.test(id)) || new Set(ids).size !== ids.length) {
      throw new ApiError(400, 'Use 1 to 3 distinct paper IDs: OpenAlex W IDs or Semantic Scholar S2:<40 hex> IDs');
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
