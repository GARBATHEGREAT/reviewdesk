/**
 * Local development database with nothing to install.
 * Starts a real PostgreSQL (from the `embedded-postgres` package) and keeps its data in api/.data/pg.
 *
 *   npm run dev:db        (leave it running in its own terminal)
 *
 * Prints the DATABASE_URL to use. For a normal setup use docker compose instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const dir = path.resolve('.data', 'pg');
const port = Number(process.env.DEV_DB_PORT ?? 54329);
const fresh = !fs.existsSync(path.join(dir, 'PG_VERSION'));

const pg = new EmbeddedPostgres({
  databaseDir: dir,
  user: 'postgres',
  password: 'postgres',
  port,
  persistent: true,
  onLog: () => undefined,
  onError: (e) => console.error(String(e)),
});

if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase('reviewdesk');

console.log(`PostgreSQL is running.\nDATABASE_URL=postgres://postgres:postgres@127.0.0.1:${port}/reviewdesk`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
