import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Express } from 'express';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { seedDemo } from './db/demo.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';

/**
 * Entry point for Vercel (serverless). Each function instance starts the app once, on its first request:
 * it connects to the database, applies pending migrations, optionally creates demo data, then serves
 * every request with the same Express app. The pool is small because many instances can run at once.
 */
let ready: Promise<Express> | undefined;

async function start(): Promise<Express> {
  const config = loadConfig({ ...process.env, NODE_ENV: 'production', DB_POOL_MAX: process.env.DB_POOL_MAX ?? '3' });
  const pool = createPool(config.DATABASE_URL, config.DB_POOL_MAX);
  await migrate(pool);
  if (config.SEED_DEMO === 'true') await seedDemo(pool, config.BCRYPT_ROUNDS);
  return createApp({ config, pool });
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    // If start-up fails (for example a wrong DATABASE_URL), try again on the next request.
    ready ??= start().catch((err) => {
      ready = undefined;
      throw err;
    });
    const app = await ready;
    app(req, res);
  } catch (err) {
    console.error('start-up failed', err);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'The service could not start. Check the database settings.' } }));
  }
}
