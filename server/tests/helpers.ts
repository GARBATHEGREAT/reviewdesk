import type { Express } from 'express';
import request from 'supertest';
import type pg from 'pg';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

export interface TestCtx {
  app: Express;
  pool: pg.Pool;
  config: Config;
  close: () => Promise<void>;
}

export async function setupApp(overrides: Record<string, string> = {}): Promise<TestCtx> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    JWT_SECRET: 'test-secret-test-secret-test-secret',
    BCRYPT_ROUNDS: '4',
    AUTH_RATE_LIMIT: '10000',
    ...overrides,
  });
  const pool = createPool(config.DATABASE_URL);
  await migrate(pool);
  return { app: createApp({ config, pool }), pool, config, close: () => pool.end() };
}

export async function resetDb(pool: pg.Pool) {
  await pool.query('TRUNCATE audit_log, reviews, tasks, projects, refresh_tokens, users RESTART IDENTITY CASCADE');
}

export interface TestUser {
  id: string;
  email: string;
  token: string;
  auth: { Authorization: string };
}

let counter = 0;

/** Register a user through the real API, then set the role directly in the database. */
export async function makeUser(ctx: TestCtx, role: 'admin' | 'reviewer' | 'viewer', name: string = role): Promise<TestUser> {
  counter++;
  const email = `${name}${counter}@example.com`;
  const res = await request(ctx.app)
    .post('/api/auth/register')
    .send({ email, name, password: 'Passw0rd-long-enough' })
    .expect(201);
  const id = res.body.user.id as string;
  await ctx.pool.query('UPDATE users SET role = $2 WHERE id = $1', [id, role]);
  // Log in again so the token carries the new role.
  const login = await request(ctx.app).post('/api/auth/login').send({ email, password: 'Passw0rd-long-enough' }).expect(200);
  const token = login.body.accessToken as string;
  return { id, email, token, auth: { Authorization: `Bearer ${token}` } };
}

export async function makeProject(ctx: TestCtx, admin: TestUser, overrides: Record<string, unknown> = {}) {
  const res = await request(ctx.app)
    .post('/api/projects')
    .set(admin.auth)
    .send({ name: 'Test project', requiredReviews: 2, ...overrides })
    .expect(201);
  return res.body.project as { id: string };
}

export async function makeTasks(ctx: TestCtx, admin: TestUser, projectId: string, n = 3) {
  const tasks = Array.from({ length: n }, (_, i) => ({ prompt: `Prompt ${i + 1}`, response: `Response ${i + 1}` }));
  const res = await request(ctx.app).post(`/api/projects/${projectId}/tasks`).set(admin.auth).send({ tasks }).expect(201);
  return res.body.items as { id: string }[];
}
