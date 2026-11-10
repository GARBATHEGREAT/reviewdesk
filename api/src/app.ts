import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import { HttpError } from './errors.js';
import { createLogger } from './logger.js';
import { createMetrics } from './metrics.js';
import { auditRouter } from './routes/audit.js';
import { authRouter } from './routes/auth.js';
import { projectsRouter } from './routes/projects.js';
import { usersRouter } from './routes/users.js';
import { workRouter } from './routes/work.js';

const snakeToCamel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** The database uses snake_case; the API speaks camelCase. Convert keys on the way out. */
export function camelize(value: unknown): unknown {
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(camelize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [snakeToCamel(k), camelize(v)]));
  }
  return value;
}

export function createApp({ config, pool }: { config: Config; pool: pg.Pool }) {
  const app = express();
  const logger = createLogger(config);
  const metrics = createMetrics();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/ready' || req.url === '/metrics' },
      // Log the essentials only (no headers, which can carry tokens and cookies).
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  const production = config.NODE_ENV === 'production';
  app.use(
    helmet({
      // HTTPS-only rules apply in production; they break plain-http local development.
      hsts: production,
      contentSecurityPolicy: { useDefaults: true, directives: { 'upgrade-insecure-requests': production ? [] : null } },
    }),
  );
  if (config.CORS_ORIGIN) {
    app.use(cors({ origin: config.CORS_ORIGIN.split(','), credentials: true }));
  }
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(metrics.middleware);

  // ---- operations endpoints ----
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
  });
  app.get('/ready', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'database unavailable' });
    }
  });
  app.get('/metrics', async (req, res) => {
    if (config.METRICS_TOKEN && req.headers.authorization !== `Bearer ${config.METRICS_TOKEN}`) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Metrics token required' } });
    }
    res.setHeader('Content-Type', metrics.registry.contentType);
    res.send(await metrics.registry.metrics());
  });

  // ---- API ----
  app.use('/api', (_req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body: unknown) => json(camelize(body));
    next();
  });
  app.use('/api/auth', authRouter(pool, config));
  app.use('/api/users', usersRouter(pool, config));
  app.use('/api/projects', projectsRouter(pool, config));
  app.use('/api/audit', auditRouter(pool, config));
  app.use('/api', workRouter(pool, config));
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  // ---- built web app (single-container deployment) ----
  if (config.WEB_DIST && fs.existsSync(config.WEB_DIST)) {
    const dist = path.resolve(config.WEB_DIST);
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  const onError: ErrorRequestHandler = (err, req, res, _next) => {
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Some fields are invalid',
          details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        },
      });
    }
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if ((err as { type?: string }).type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Request body is not valid JSON' } });
    }
    if ((err as { type?: string }).type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' } });
    }
    req.log.error({ err }, 'unhandled error');
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
  };
  app.use(onError);

  return app;
}
