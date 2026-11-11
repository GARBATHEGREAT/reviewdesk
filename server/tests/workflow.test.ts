import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeProject, makeTasks, makeUser, resetDb, setupApp, type TestCtx, type TestUser } from './helpers.js';

let ctx: TestCtx;
let admin: TestUser, rita: TestUser, ravi: TestUser;
beforeAll(async () => {
  ctx = await setupApp();
});
afterAll(async () => ctx.close());
beforeEach(async () => {
  await resetDb(ctx.pool);
  admin = await makeUser(ctx, 'admin');
  rita = await makeUser(ctx, 'reviewer', 'rita');
  ravi = await makeUser(ctx, 'reviewer', 'ravi');
});

const review = (user: TestUser, taskId: string, body: Record<string, unknown>) =>
  request(ctx.app).post(`/api/tasks/${taskId}/reviews`).set(user.auth).send(body);

describe('projects', () => {
  it('creates, lists, updates and archives a project', async () => {
    const project = await makeProject(ctx, admin, { name: 'Alpha', description: 'First' });
    const list = await request(ctx.app).get('/api/projects').set(rita.auth).expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ name: 'Alpha', taskCount: 0, doneCount: 0 });

    const patched = await request(ctx.app).patch(`/api/projects/${project.id}`).set(admin.auth).send({ name: 'Beta' }).expect(200);
    expect(patched.body.project.name).toBe('Beta');
    expect(patched.body.project.description).toBe('First');

    await request(ctx.app).delete(`/api/projects/${project.id}`).set(admin.auth).expect(204);
    expect((await request(ctx.app).get('/api/projects').set(admin.auth)).body.items).toHaveLength(0);
    expect((await request(ctx.app).get('/api/projects?archived=true').set(admin.auth)).body.items).toHaveLength(1);
  });

  it('validates input and returns 404 for an unknown project', async () => {
    await request(ctx.app).post('/api/projects').set(admin.auth).send({ name: '' }).expect(400);
    await request(ctx.app).post('/api/projects').set(admin.auth).send({ name: 'x', requiredReviews: 99 }).expect(400);
    await request(ctx.app).get('/api/projects/00000000-0000-4000-8000-000000000000').set(admin.auth).expect(404);
    await request(ctx.app).get('/api/projects/not-a-uuid').set(admin.auth).expect(400);
  });

  it('answers malformed JSON with a clean 400', async () => {
    const res = await request(ctx.app).post('/api/projects').set(admin.auth).set('Content-Type', 'application/json').send('{bad json').expect(400);
    expect(res.body.error.code).toBe('BAD_JSON');
  });
});

describe('tasks', () => {
  it('adds tasks in bulk and paginates them', async () => {
    const project = await makeProject(ctx, admin);
    await makeTasks(ctx, admin, project.id, 5);
    const page = await request(ctx.app).get(`/api/projects/${project.id}/tasks?pageSize=2&page=3`).set(rita.auth).expect(200);
    expect(page.body).toMatchObject({ total: 5, page: 3, pageSize: 2 });
    expect(page.body.items).toHaveLength(1);
  });

  it('refuses to add tasks to an archived project', async () => {
    const project = await makeProject(ctx, admin);
    await request(ctx.app).delete(`/api/projects/${project.id}`).set(admin.auth).expect(204);
    const res = await request(ctx.app)
      .post(`/api/projects/${project.id}/tasks`)
      .set(admin.auth)
      .send({ tasks: [{ prompt: 'p', response: 'r' }] })
      .expect(409);
    expect(res.body.error.code).toBe('PROJECT_ARCHIVED');
  });

  it('serves each reviewer the next task they have not rated, assigned work first', async () => {
    const project = await makeProject(ctx, admin);
    const [t1, t2, t3] = await makeTasks(ctx, admin, project.id, 3);
    await request(ctx.app).patch(`/api/tasks/${t3!.id}`).set(admin.auth).send({ assigneeId: rita.id }).expect(200);

    const first = await request(ctx.app).get(`/api/projects/${project.id}/next-task`).set(rita.auth).expect(200);
    expect(first.body.task.id).toBe(t3!.id);

    await review(rita, t3!.id, { rating: 3, verdict: 'pass' }).expect(201);
    const second = await request(ctx.app).get(`/api/projects/${project.id}/next-task`).set(rita.auth).expect(200);
    expect(second.body.task.id).toBe(t1!.id);

    // Ravi must not be handed the task assigned to Rita
    await request(ctx.app).patch(`/api/tasks/${t2!.id}`).set(admin.auth).send({ assigneeId: rita.id }).expect(200);
    const ravis = await request(ctx.app).get(`/api/projects/${project.id}/next-task`).set(ravi.auth).expect(200);
    expect([t1!.id]).toContain(ravis.body.task.id);
  });

  it('serves tasks in the order they were added, even when added in one batch', async () => {
    const project = await makeProject(ctx, admin);
    const tasks = await makeTasks(ctx, admin, project.id, 8);
    const listed = await request(ctx.app).get(`/api/projects/${project.id}/tasks?pageSize=100`).set(rita.auth).expect(200);
    expect(listed.body.items.map((t: { id: string }) => t.id)).toEqual(tasks.map((t) => t.id));
    for (const expected of tasks.slice(0, 3)) {
      const next = await request(ctx.app).get(`/api/projects/${project.id}/next-task`).set(rita.auth).expect(200);
      expect(next.body.task.id).toBe(expected.id);
      await review(rita, expected.id, { rating: 3, verdict: 'pass' }).expect(201);
    }
  });

  it('returns 404 when there is nothing left to review', async () => {
    const project = await makeProject(ctx, admin);
    await request(ctx.app).get(`/api/projects/${project.id}/next-task`).set(rita.auth).expect(404);
  });
});

describe('reviews', () => {
  it('moves a task to in_review, then done once enough reviews are in', async () => {
    const project = await makeProject(ctx, admin, { requiredReviews: 2 });
    const [task] = await makeTasks(ctx, admin, project.id, 1);
    const first = await review(rita, task!.id, { rating: 5, verdict: 'pass', notes: 'Correct' }).expect(201);
    expect(first.body.review.taskStatus).toBe('in_review');
    const second = await review(ravi, task!.id, { rating: 4, verdict: 'pass' }).expect(201);
    expect(second.body.review.taskStatus).toBe('done');
  });

  it('refuses a second review from the same person and reviews on closed tasks', async () => {
    const project = await makeProject(ctx, admin, { requiredReviews: 1 });
    const [task] = await makeTasks(ctx, admin, project.id, 1);
    await review(rita, task!.id, { rating: 5, verdict: 'pass' }).expect(201);
    const closed = await review(ravi, task!.id, { rating: 1, verdict: 'fail' }).expect(409);
    expect(closed.body.error.code).toBe('TASK_CLOSED');

    const project2 = await makeProject(ctx, admin, { requiredReviews: 3 });
    const [task2] = await makeTasks(ctx, admin, project2.id, 1);
    await review(rita, task2!.id, { rating: 5, verdict: 'pass' }).expect(201);
    const dup = await review(rita, task2!.id, { rating: 2, verdict: 'fail' }).expect(409);
    expect(dup.body.error.code).toBe('ALREADY_REVIEWED');
  });

  it('does not double count when two reviewers submit at the same moment', async () => {
    const project = await makeProject(ctx, admin, { requiredReviews: 2 });
    const [task] = await makeTasks(ctx, admin, project.id, 1);
    const results = await Promise.all([
      review(rita, task!.id, { rating: 5, verdict: 'pass' }),
      review(ravi, task!.id, { rating: 4, verdict: 'pass' }),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    const { rows } = await ctx.pool.query('SELECT status FROM tasks WHERE id = $1', [task!.id]);
    expect(rows[0].status).toBe('done');
  });

  it('validates the review fields', async () => {
    const project = await makeProject(ctx, admin);
    const [task] = await makeTasks(ctx, admin, project.id, 1);
    await review(rita, task!.id, { rating: 9, verdict: 'pass' }).expect(400);
    await review(rita, task!.id, { rating: 3, verdict: 'great' }).expect(400);
    await review(rita, '00000000-0000-4000-8000-000000000000', { rating: 3, verdict: 'pass' }).expect(404);
  });

  it('keeps reviews blind until the reviewer has submitted their own', async () => {
    const project = await makeProject(ctx, admin, { requiredReviews: 3 });
    const [task] = await makeTasks(ctx, admin, project.id, 1);
    await review(ravi, task!.id, { rating: 2, verdict: 'fail' }).expect(201);

    const before = await request(ctx.app).get(`/api/tasks/${task!.id}/reviews`).set(rita.auth).expect(200);
    expect(before.body).toMatchObject({ items: [], blind: true });

    await review(rita, task!.id, { rating: 5, verdict: 'pass' }).expect(201);
    const after = await request(ctx.app).get(`/api/tasks/${task!.id}/reviews`).set(rita.auth).expect(200);
    expect(after.body.items).toHaveLength(2);
    expect(after.body.blind).toBe(false);

    const adminView = await request(ctx.app).get(`/api/tasks/${task!.id}/reviews`).set(admin.auth).expect(200);
    expect(adminView.body.items).toHaveLength(2);
  });

  it('stops a reviewer taking a task assigned to someone else', async () => {
    const project = await makeProject(ctx, admin);
    const [task] = await makeTasks(ctx, admin, project.id, 1);
    await request(ctx.app).patch(`/api/tasks/${task!.id}`).set(admin.auth).send({ assigneeId: rita.id }).expect(200);
    await review(ravi, task!.id, { rating: 3, verdict: 'pass' }).expect(403);
    await review(rita, task!.id, { rating: 3, verdict: 'pass' }).expect(201);
  });
});

describe('stats and export', () => {
  async function scoredProject() {
    const project = await makeProject(ctx, admin, { requiredReviews: 2 });
    const tasks = await makeTasks(ctx, admin, project.id, 4);
    const verdictsRita = ['pass', 'pass', 'fail', 'fail'];
    const verdictsRavi = ['pass', 'fail', 'pass', 'fail'];
    for (let i = 0; i < 4; i++) {
      await review(rita, tasks[i]!.id, { rating: 4, verdict: verdictsRita[i] }).expect(201);
      await review(ravi, tasks[i]!.id, { rating: 2, verdict: verdictsRavi[i] }).expect(201);
    }
    return project;
  }

  it('reports progress, verdicts and inter-reviewer agreement', async () => {
    const project = await scoredProject();
    const { body } = await request(ctx.app).get(`/api/projects/${project.id}/stats`).set(admin.auth).expect(200);
    expect(body.tasks).toMatchObject({ done: 4, open: 0, total: 4 });
    expect(body.reviews).toMatchObject({ total: 8, averageRating: 3 });
    expect(body.agreement.pairs).toHaveLength(1);
    expect(body.agreement.pairs[0]).toMatchObject({ sharedTasks: 4, percentAgreement: 50 });
    expect(body.agreement.averageKappa).toBe(0);
    expect(body.agreement.interpretation).toContain('weak');
  });

  it('exports every review as CSV and protects against formula injection', async () => {
    const project = await makeProject(ctx, admin, { requiredReviews: 1 });
    await request(ctx.app)
      .post(`/api/projects/${project.id}/tasks`)
      .set(admin.auth)
      .send({ tasks: [{ prompt: 'Say, "hello"', response: '=SUM(1,2)' }] })
      .expect(201);
    const csv = await request(ctx.app).get(`/api/projects/${project.id}/export.csv`).set(admin.auth).expect(200);
    const lines = csv.text.trim().split('\n');
    expect(lines[0]).toBe('task_id,prompt,response,status,reviewer,rating,verdict,notes');
    expect(csv.text).toContain('"Say, ""hello"""');
    expect(csv.text).toContain("'=SUM(1,2)");
    expect(csv.headers['content-disposition']).toContain('attachment');
  });
});
