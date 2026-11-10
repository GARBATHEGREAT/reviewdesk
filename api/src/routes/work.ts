import { Router } from 'express';
import type pg from 'pg';
import type { Config } from '../config.js';
import { isUniqueViolation, withTransaction } from '../db/pool.js';
import { conflict, forbidden, notFound, wrap } from '../errors.js';
import { audit } from '../lib/audit.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { listQuery, reviewBody, taskPatch, tasksBody, uuid } from '../schemas.js';

/** Tasks (items to review) and the reviews written about them. Mounted at /api. */
export function workRouter(pool: pg.Pool, config: Config): Router {
  const router = Router();
  const auth = authenticate(config);

  async function assertProject(id: string) {
    const { rows } = await pool.query<{ id: string; archived: boolean }>('SELECT id, archived FROM projects WHERE id = $1', [id]);
    if (!rows[0]) throw notFound('Project');
    return rows[0];
  }

  router.get(
    '/projects/:projectId/tasks',
    auth,
    wrap(async (req, res) => {
      const projectId = uuid.parse(req.params.projectId);
      const q = listQuery.parse(req.query);
      await assertProject(projectId);
      const mine = req.query.mine === 'true';
      const params: unknown[] = [projectId, q.status ?? null, mine ? req.user!.id : null];
      const where = `t.project_id = $1 AND ($2::text IS NULL OR t.status = $2) AND ($3::uuid IS NULL OR t.assignee_id = $3)`;
      const { rows: total } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM tasks t WHERE ${where}`, params);
      const { rows } = await pool.query(
        `SELECT t.id, t.project_id, t.prompt, t.response, t.status, t.assignee_id, t.created_at,
                (SELECT count(*)::int FROM reviews r WHERE r.task_id = t.id) AS review_count,
                EXISTS (SELECT 1 FROM reviews r WHERE r.task_id = t.id AND r.reviewer_id = $4) AS reviewed_by_me
           FROM tasks t WHERE ${where}
          ORDER BY t.seq ASC LIMIT $5 OFFSET $6`,
        [...params, req.user!.id, q.pageSize, (q.page - 1) * q.pageSize],
      );
      res.json({ items: rows, total: total[0]?.n ?? 0, page: q.page, pageSize: q.pageSize });
    }),
  );

  router.post(
    '/projects/:projectId/tasks',
    auth,
    requireRole('admin'),
    wrap(async (req, res) => {
      const projectId = uuid.parse(req.params.projectId);
      const body = tasksBody.parse(req.body);
      const project = await assertProject(projectId);
      if (project.archived) throw conflict('PROJECT_ARCHIVED', 'Archived projects cannot receive new tasks');
      const created = await withTransaction(pool, async (client) => {
        const out = [];
        for (const t of body.tasks) {
          const { rows } = await client.query(
            'INSERT INTO tasks (project_id, prompt, response) VALUES ($1, $2, $3) RETURNING *',
            [projectId, t.prompt, t.response],
          );
          out.push(rows[0]);
        }
        await audit(client, req.user!.id, 'task.create', 'project', projectId, { count: out.length });
        return out;
      });
      res.status(201).json({ items: created });
    }),
  );

  /** The next task this reviewer should work on: assigned to them first, then unassigned. */
  router.get(
    '/projects/:projectId/next-task',
    auth,
    wrap(async (req, res) => {
      const projectId = uuid.parse(req.params.projectId);
      const project = await assertProject(projectId);
      if (project.archived) throw conflict('PROJECT_ARCHIVED', 'This project is archived');
      const { rows } = await pool.query(
        `SELECT t.* FROM tasks t
          WHERE t.project_id = $1 AND t.status <> 'done'
            AND (t.assignee_id IS NULL OR t.assignee_id = $2)
            AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.task_id = t.id AND r.reviewer_id = $2)
          ORDER BY (t.assignee_id = $2) DESC NULLS LAST, t.seq ASC LIMIT 1`,
        [projectId, req.user!.id],
      );
      if (!rows[0]) throw notFound('Task to review');
      res.json({ task: rows[0] });
    }),
  );

  router.get(
    '/tasks/:id',
    auth,
    wrap(async (req, res) => {
      const { rows } = await pool.query('SELECT * FROM tasks WHERE id = $1', [uuid.parse(req.params.id)]);
      if (!rows[0]) throw notFound('Task');
      res.json({ task: rows[0] });
    }),
  );

  router.patch(
    '/tasks/:id',
    auth,
    requireRole('admin'),
    wrap(async (req, res) => {
      const id = uuid.parse(req.params.id);
      const { assigneeId } = taskPatch.parse(req.body);
      if (assigneeId) {
        const { rows } = await pool.query('SELECT 1 FROM users WHERE id = $1', [assigneeId]);
        if (!rows[0]) throw notFound('Assignee');
      }
      const { rows } = await pool.query('UPDATE tasks SET assignee_id = $2 WHERE id = $1 RETURNING *', [id, assigneeId]);
      if (!rows[0]) throw notFound('Task');
      await audit(pool, req.user!.id, 'task.assign', 'task', id, { assigneeId });
      res.json({ task: rows[0] });
    }),
  );

  router.post(
    '/tasks/:id/reviews',
    auth,
    requireRole('admin', 'reviewer'),
    wrap(async (req, res) => {
      const taskId = uuid.parse(req.params.id);
      const body = reviewBody.parse(req.body);
      try {
        const review = await withTransaction(pool, async (client) => {
          const { rows } = await client.query<{
            status: string;
            assignee_id: string | null;
            required_reviews: number;
            archived: boolean;
          }>(
            `SELECT t.status, t.assignee_id, p.required_reviews, p.archived
               FROM tasks t JOIN projects p ON p.id = t.project_id
              WHERE t.id = $1 FOR UPDATE OF t`,
            [taskId],
          );
          const task = rows[0];
          if (!task) throw notFound('Task');
          if (task.archived) throw conflict('PROJECT_ARCHIVED', 'This project is archived');
          if (task.status === 'done') throw conflict('TASK_CLOSED', 'This task already has all the reviews it needs');
          if (req.user!.role === 'reviewer' && task.assignee_id && task.assignee_id !== req.user!.id) {
            throw forbidden('This task is assigned to another reviewer');
          }
          const { rows: inserted } = await client.query(
            `INSERT INTO reviews (task_id, reviewer_id, rating, verdict, notes)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [taskId, req.user!.id, body.rating, body.verdict, body.notes],
          );
          const { rows: count } = await client.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM reviews WHERE task_id = $1',
            [taskId],
          );
          const status = (count[0]?.n ?? 0) >= task.required_reviews ? 'done' : 'in_review';
          await client.query('UPDATE tasks SET status = $2 WHERE id = $1', [taskId, status]);
          await audit(client, req.user!.id, 'review.create', 'task', taskId, { verdict: body.verdict });
          return { ...inserted[0], taskStatus: status };
        });
        res.status(201).json({ review });
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('ALREADY_REVIEWED', 'You have already reviewed this task');
        throw err;
      }
    }),
  );

  /**
   * Blind review: a reviewer sees other reviewers' work only after submitting their own,
   * so one opinion cannot influence another.
   */
  router.get(
    '/tasks/:id/reviews',
    auth,
    wrap(async (req, res) => {
      const taskId = uuid.parse(req.params.id);
      const { rows: t } = await pool.query('SELECT 1 FROM tasks WHERE id = $1', [taskId]);
      if (!t[0]) throw notFound('Task');
      let onlyMine = false;
      if (req.user!.role === 'reviewer') {
        const { rows } = await pool.query('SELECT 1 FROM reviews WHERE task_id = $1 AND reviewer_id = $2', [
          taskId,
          req.user!.id,
        ]);
        onlyMine = !rows[0];
      }
      const { rows } = await pool.query(
        `SELECT r.id, r.task_id, r.reviewer_id, u.name AS reviewer_name, r.rating, r.verdict, r.notes, r.created_at
           FROM reviews r JOIN users u ON u.id = r.reviewer_id
          WHERE r.task_id = $1 AND ($2::boolean = false OR r.reviewer_id = $3)
          ORDER BY r.created_at ASC`,
        [taskId, onlyMine, req.user!.id],
      );
      res.json({ items: rows, blind: onlyMine });
    }),
  );

  return router;
}
