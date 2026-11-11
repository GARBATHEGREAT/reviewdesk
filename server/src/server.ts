import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { seedDemo } from './db/demo.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const logger = createLogger(config);
const pool = createPool(config.DATABASE_URL, config.DB_POOL_MAX);

// Apply pending migrations before accepting traffic.
const applied = await migrate(pool);
if (applied.length) logger.info({ applied }, 'database migrated');

if (config.SEED_DEMO === 'true') {
  await seedDemo(pool, config.BCRYPT_ROUNDS);
  logger.info('demo data ready');
}

const app = createApp({ config, pool });
const server = app.listen(config.PORT, () => logger.info({ port: config.PORT }, 'ReviewDesk API listening'));

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
