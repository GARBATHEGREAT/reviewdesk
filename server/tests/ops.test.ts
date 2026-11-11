import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate } from '../src/db/migrate.js';
import { setupApp, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await setupApp();
});
afterAll(async () => ctx.close());

describe('health and monitoring', () => {
  it('/health is always up', async () => {
    const res = await request(ctx.app).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('/ready checks the database', async () => {
    await request(ctx.app).get('/ready').expect(200);
    const broken = await setupApp();
    await broken.pool.end();
    await request(broken.app).get('/ready').expect(503);
  });

  it('/metrics exposes Prometheus metrics including request timings', async () => {
    await request(ctx.app).get('/api/projects');
    const res = await request(ctx.app).get('/metrics').expect(200);
    expect(res.text).toContain('http_request_duration_seconds');
    expect(res.text).toContain('process_cpu_user_seconds_total');
  });

  it('can protect /metrics with a token', async () => {
    const secured = await setupApp({ METRICS_TOKEN: 'metrics-secret' });
    try {
      await request(secured.app).get('/metrics').expect(401);
      await request(secured.app).get('/metrics').set('Authorization', 'Bearer metrics-secret').expect(200);
    } finally {
      await secured.pool.end();
    }
  });

  it('returns a request id and a JSON 404 for unknown API routes', async () => {
    const res = await request(ctx.app).get('/api/nope').expect(404);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('sets security headers', async () => {
    const res = await request(ctx.app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('demo data', () => {
  it('can be created more than once without duplicates', async () => {
    const { seedDemo } = await import('../src/db/demo.js');
    await ctx.pool.query('TRUNCATE audit_log, reviews, tasks, projects, refresh_tokens, users RESTART IDENTITY CASCADE');
    await seedDemo(ctx.pool, 4);
    await seedDemo(ctx.pool, 4);
    const users = await ctx.pool.query('SELECT count(*)::int AS n FROM users');
    const tasks = await ctx.pool.query('SELECT count(*)::int AS n FROM tasks');
    expect([users.rows[0].n, tasks.rows[0].n]).toEqual([3, 10]);
  });
});

describe('migrations', () => {
  it('are idempotent: running them again applies nothing', async () => {
    expect(await migrate(ctx.pool)).toEqual([]);
  });

  it('record what has run, in order', async () => {
    const { rows } = await ctx.pool.query('SELECT name FROM schema_migrations ORDER BY name');
    expect(rows.map((r) => r.name)).toEqual(['001_init.sql', '002_audit_log.sql', '003_task_order.sql']);
  });

  it('enforce data rules in the database itself', async () => {
    await expect(
      ctx.pool.query("INSERT INTO users (email, name, password_hash, role) VALUES ('a@b.co','A','x','superuser')"),
    ).rejects.toThrow(/check constraint/);
  });

  it('roll back a failing migration and leave no trace', async () => {
    const dir = await import('node:fs/promises').then(async (fs) => {
      const os = await import('node:os');
      const path = await import('node:path');
      const d = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-mig-'));
      await fs.writeFile(path.join(d, '900_bad.sql'), 'CREATE TABLE half_done (id int); SELECT * FROM table_that_does_not_exist;');
      return d;
    });
    await expect(migrate(ctx.pool, dir)).rejects.toThrow(/900_bad.sql failed/);
    const { rows } = await ctx.pool.query("SELECT to_regclass('half_done') AS t");
    expect(rows[0].t).toBeNull();
    const pool2: pg.Pool = ctx.pool;
    const { rows: recorded } = await pool2.query("SELECT 1 FROM schema_migrations WHERE name = '900_bad.sql'");
    expect(recorded).toHaveLength(0);
  });
});
