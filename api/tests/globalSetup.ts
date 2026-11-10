import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * Integration tests need a real PostgreSQL.
 *  - In CI (or when you set TEST_DATABASE_URL) that database is used as is.
 *  - Otherwise a throwaway PostgreSQL is started from the `embedded-postgres` package,
 *    so `npm test` works on a laptop with nothing installed.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export default async function setup() {
  if (process.env.TEST_DATABASE_URL) return;

  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewdesk-pg-'));
  const port = await freePort();
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
    onLog: () => undefined,
    onError: () => undefined,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('reviewdesk_test');
  process.env.TEST_DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${port}/reviewdesk_test`;

  return async () => {
    await pg.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  };
}
