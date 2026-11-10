import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeProject, makeTasks, makeUser, resetDb, setupApp, type TestCtx, type TestUser } from './helpers.js';

let ctx: TestCtx;
let admin: TestUser, reviewer: TestUser, viewer: TestUser;
beforeAll(async () => {
  ctx = await setupApp();
});
afterAll(async () => ctx.close());
beforeEach(async () => {
  await resetDb(ctx.pool);
  admin = await makeUser(ctx, 'admin');
  reviewer = await makeUser(ctx, 'reviewer');
  viewer = await makeUser(ctx, 'viewer');
});

describe('role-based access control', () => {
  it('requires a login for every API route', async () => {
    for (const url of ['/api/projects', '/api/users', '/api/audit']) {
      await request(ctx.app).get(url).expect(401);
    }
  });

  it('lets only admins create projects', async () => {
    const body = { name: 'P' };
    await request(ctx.app).post('/api/projects').set(reviewer.auth).send(body).expect(403);
    await request(ctx.app).post('/api/projects').set(viewer.auth).send(body).expect(403);
    await request(ctx.app).post('/api/projects').set(admin.auth).send(body).expect(201);
  });

  it('lets only admins manage users and read the audit log', async () => {
    await request(ctx.app).get('/api/users').set(reviewer.auth).expect(403);
    await request(ctx.app).get('/api/audit').set(viewer.auth).expect(403);
    const users = await request(ctx.app).get('/api/users').set(admin.auth).expect(200);
    expect(users.body.items).toHaveLength(3);
    expect(JSON.stringify(users.body)).not.toContain('passwordHash');
  });

  it('lets only admins and reviewers write reviews; viewers can read', async () => {
    const project = await makeProject(ctx, admin);
    const [task] = await makeTasks(ctx, admin, project.id, 1);
    const review = { rating: 4, verdict: 'pass' };
    await request(ctx.app).post(`/api/tasks/${task!.id}/reviews`).set(viewer.auth).send(review).expect(403);
    await request(ctx.app).post(`/api/tasks/${task!.id}/reviews`).set(reviewer.auth).send(review).expect(201);
    await request(ctx.app).get(`/api/projects/${project.id}/stats`).set(viewer.auth).expect(200);
  });

  it('lets only admins and viewers export CSV', async () => {
    const project = await makeProject(ctx, admin);
    await request(ctx.app).get(`/api/projects/${project.id}/export.csv`).set(reviewer.auth).expect(403);
    const csv = await request(ctx.app).get(`/api/projects/${project.id}/export.csv`).set(viewer.auth).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
  });

  it('ignores a role claimed by the client', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/register')
      .send({ email: 'sneaky@example.com', name: 'Sneaky', password: 'Passw0rd-long-enough', role: 'admin' })
      .expect(201);
    expect(res.body.user.role).toBe('reviewer');
  });
});

describe('PATCH /api/users/:id/role', () => {
  it('changes a role and records it in the audit log', async () => {
    await request(ctx.app).patch(`/api/users/${reviewer.id}/role`).set(admin.auth).send({ role: 'viewer' }).expect(200);
    const audit = await request(ctx.app).get('/api/audit').set(admin.auth).expect(200);
    expect(audit.body.items.some((a: { action: string }) => a.action === 'user.role_changed')).toBe(true);
  });

  it('never removes the last admin', async () => {
    const res = await request(ctx.app).patch(`/api/users/${admin.id}/role`).set(admin.auth).send({ role: 'reviewer' }).expect(409);
    expect(res.body.error.code).toBe('LAST_ADMIN');
  });

  it('validates the id and the role', async () => {
    await request(ctx.app).patch('/api/users/not-a-uuid/role').set(admin.auth).send({ role: 'viewer' }).expect(400);
    await request(ctx.app).patch(`/api/users/${reviewer.id}/role`).set(admin.auth).send({ role: 'owner' }).expect(400);
    await request(ctx.app)
      .patch('/api/users/00000000-0000-4000-8000-000000000000/role')
      .set(admin.auth)
      .send({ role: 'viewer' })
      .expect(404);
  });
});
