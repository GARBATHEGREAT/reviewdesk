import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, setupApp, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await setupApp();
});
afterAll(async () => ctx.close());
beforeEach(async () => resetDb(ctx.pool));

const creds = { email: 'ada@example.com', name: 'Ada', password: 'Passw0rd-long-enough' };

describe('POST /api/auth/register', () => {
  it('makes the very first user an admin and later users reviewers', async () => {
    const first = await request(ctx.app).post('/api/auth/register').send(creds).expect(201);
    expect(first.body.user.role).toBe('admin');
    expect(first.body.accessToken).toBeTruthy();
    expect(first.body.user.passwordHash).toBeUndefined();

    const second = await request(ctx.app)
      .post('/api/auth/register')
      .send({ ...creds, email: 'bob@example.com', name: 'Bob' })
      .expect(201);
    expect(second.body.user.role).toBe('reviewer');
  });

  it('never stores the password in clear text', async () => {
    await request(ctx.app).post('/api/auth/register').send(creds).expect(201);
    const { rows } = await ctx.pool.query('SELECT password_hash FROM users');
    expect(rows[0].password_hash).not.toContain(creds.password);
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$/);
  });

  it('rejects a duplicate email regardless of letter case', async () => {
    await request(ctx.app).post('/api/auth/register').send(creds).expect(201);
    const res = await request(ctx.app)
      .post('/api/auth/register')
      .send({ ...creds, email: 'ADA@Example.com' })
      .expect(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('returns field-level validation errors', async () => {
    const res = await request(ctx.app).post('/api/auth/register').send({ email: 'nope', name: '', password: 'short' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const fields = res.body.error.details.map((d: { field: string }) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['email', 'name', 'password']));
  });

  it('gives exactly one admin when many people register at once', async () => {
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        request(ctx.app).post('/api/auth/register').send({ ...creds, email: `u${i}@example.com` }),
      ),
    );
    const { rows } = await ctx.pool.query("SELECT count(*)::int AS n FROM users WHERE role = 'admin'");
    expect(rows[0].n).toBe(1);
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    await request(ctx.app).post('/api/auth/register').send(creds).expect(201);
  });

  it('signs in with the right password', async () => {
    const res = await request(ctx.app).post('/api/auth/login').send({ email: creds.email, password: creds.password }).expect(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.headers['set-cookie']?.[0]).toMatch(/rd_refresh=.*HttpOnly.*SameSite=Strict/i);
  });

  it('gives the same error for a wrong password and an unknown email', async () => {
    const wrong = await request(ctx.app).post('/api/auth/login').send({ email: creds.email, password: 'wrong-password-1' }).expect(401);
    const unknown = await request(ctx.app).post('/api/auth/login').send({ email: 'ghost@example.com', password: 'wrong-password-1' }).expect(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });
});

describe('sessions', () => {
  it('protects /me and accepts a valid token', async () => {
    await request(ctx.app).get('/api/auth/me').expect(401);
    await request(ctx.app).get('/api/auth/me').set('Authorization', 'Bearer garbage').expect(401);
    const reg = await request(ctx.app).post('/api/auth/register').send(creds).expect(201);
    const me = await request(ctx.app).get('/api/auth/me').set('Authorization', `Bearer ${reg.body.accessToken}`).expect(200);
    expect(me.body.user.email).toBe(creds.email);
  });

  it('rotates the refresh token and rejects the old one', async () => {
    const agent = request.agent(ctx.app);
    await agent.post('/api/auth/register').send(creds).expect(201);
    const oldCookie = (await agent.post('/api/auth/login').send({ email: creds.email, password: creds.password })).headers['set-cookie']![0]!;
    const refreshed = await request(ctx.app).post('/api/auth/refresh').set('Cookie', oldCookie).expect(200);
    expect(refreshed.body.accessToken).toBeTruthy();
    // Using the old token again means it may have been stolen: refused, and all sessions are revoked.
    await request(ctx.app).post('/api/auth/refresh').set('Cookie', oldCookie).expect(401);
    const newCookie = refreshed.headers['set-cookie']![0]!;
    await request(ctx.app).post('/api/auth/refresh').set('Cookie', newCookie).expect(401);
  });

  it('logout invalidates the refresh token', async () => {
    const login = await request(ctx.app).post('/api/auth/register').send(creds).expect(201);
    const cookie = login.headers['set-cookie']![0]!;
    await request(ctx.app).post('/api/auth/logout').set('Cookie', cookie).expect(204);
    await request(ctx.app).post('/api/auth/refresh').set('Cookie', cookie).expect(401);
  });

  it('refuses a refresh without a cookie', async () => {
    await request(ctx.app).post('/api/auth/refresh').expect(401);
  });
});

describe('rate limiting', () => {
  it('blocks repeated login attempts', async () => {
    const limited = await setupApp({ AUTH_RATE_LIMIT: '3' });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await request(limited.app).post('/api/auth/login').send({ email: 'x@example.com', password: 'whatever-1' });
        statuses.push(r.status);
      }
      expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
      expect(statuses.slice(3)).toEqual([429, 429]);
    } finally {
      await limited.pool.end();
    }
  });
});
