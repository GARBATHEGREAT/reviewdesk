import { Router } from 'express';
import type pg from 'pg';
import type { Config } from '../config.js';
import { notFound, wrap } from '../errors.js';
import { audit } from '../lib/audit.js';
import { toCsv } from '../lib/csv.js';
import { interpretKappa, pairwiseAgreement } from '../lib/kappa.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { projectBody, projectPatch, uuid } from '../schemas.js';

export function projectsRouter(pool: pg.Pool, config: Config): Router {
  const router = Router();
  router.use(authenticate(config));

  async function getProject(id: string) {
    const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1', [id]);
    if (!rows[0]) throw notFound('Project');
    return rows[0];
  }

  router.get(
    '/',
    wrap(async (req, res) => {
      const includeArchived = req.query.archived === 'true';
      const { rows } = await pool.query(
        `SELECT p.id, p.name, p.description, p.required_reviews, p.archived, p.created_at,
                count(t.id)::int AS task_count,
                count(t.id) FILTER (WHERE t.status = 'done')::int AS done_count
           FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
          WHERE ($1::boolean OR p.archived = false)
          GROUP BY p.id ORDER BY p.created_at DESC`,
        [includeArchived],
      );
      res.json({ items: rows });
    }),
  );

  router.post(
    '/',
    requireRole('admin'),
    wrap(async (req, res) => {
      const b = projectBody.parse(req.body);
      const { rows } = await pool.query(
        `INSERT INTO projects (name, description, rubric, required_reviews, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [b.name, b.description, b.rubric, b.requiredReviews, req.user!.id],
      );
      await audit(pool, req.user!.id, 'project.create', 'project', rows[0].id, { name: b.name });
      res.status(201).json({ project: rows[0] });
    }),
  );

  router.get(
    '/:id',
    wrap(async (req, res) => {
      res.json({ project: await getProject(uuid.parse(req.params.id)) });
    }),
  );

  router.patch(
    '/:id',
    requireRole('admin'),
    wrap(async (req, res) => {
      const id = uuid.parse(req.params.id);
      const b = projectPatch.parse(req.body);
      await getProject(id);
      const { rows } = await pool.query(
        `UPDATE projects SET
           name = COALESCE($2, name),
           description = COALESCE($3, description),
           rubric = COALESCE($4, rubric),
           required_reviews = COALESCE($5, required_reviews),
           archived = COALESCE($6, archived),
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, b.name ?? null, b.description ?? null, b.rubric ?? null, b.requiredReviews ?? null, b.archived ?? null],
      );
      await audit(pool, req.user!.id, 'project.update', 'project', id, b as Record<string, unknown>);
      res.json({ project: rows[0] });
    }),
  );

  router.delete(
    '/:id',
    requireRole('admin'),
    wrap(async (req, res) => {
      const id = uuid.parse(req.params.id);
      await getProject(id);
      await pool.query('UPDATE projects SET archived = true, updated_at = now() WHERE id = $1', [id]);
      await audit(pool, req.user!.id, 'project.archive', 'project', id);
      res.status(204).end();
    }),
  );

  router.get(
    '/:id/stats',
    wrap(async (req, res) => {
      const id = uuid.parse(req.params.id);
      await getProject(id);
      const { rows: status } = await pool.query<{ status: string; n: number }>(
        'SELECT status, count(*)::int AS n FROM tasks WHERE project_id = $1 GROUP BY status',
        [id],
      );
      const { rows: reviews } = await pool.query<{
        task_id: string;
        reviewer_id: string;
        reviewer_name: string;
        rating: number;
        verdict: string;
      }>(
        `SELECT r.task_id, r.reviewer_id, u.name AS reviewer_name, r.rating, r.verdict
           FROM reviews r JOIN tasks t ON t.id = r.task_id JOIN users u ON u.id = r.reviewer_id
          WHERE t.project_id = $1`,
        [id],
      );
      const tasks = { open: 0, in_review: 0, done: 0 } as Record<string, number>;
      for (const s of status) tasks[s.status] = s.n;
      const verdicts = { pass: 0, fail: 0, unsure: 0 } as Record<string, number>;
      let ratingSum = 0;
      const perReviewer = new Map<string, { name: string; reviews: number; ratingSum: number }>();
      for (const r of reviews) {
        verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
        ratingSum += r.rating;
        const p = perReviewer.get(r.reviewer_id) ?? { name: r.reviewer_name, reviews: 0, ratingSum: 0 };
        p.reviews++;
        p.ratingSum += r.rating;
        perReviewer.set(r.reviewer_id, p);
      }
      const names = new Map([...perReviewer].map(([k, v]) => [k, v.name]));
      const agreement = pairwiseAgreement(
        reviews.map((r) => ({ taskId: r.task_id, reviewerId: r.reviewer_id, verdict: r.verdict })),
      );
      res.json({
        tasks: { ...tasks, total: tasks.open! + tasks.in_review! + tasks.done! },
        reviews: {
          total: reviews.length,
          averageRating: reviews.length ? Math.round((ratingSum / reviews.length) * 100) / 100 : null,
          verdicts,
        },
        reviewers: [...perReviewer].map(([reviewerId, v]) => ({
          reviewerId,
          name: v.name,
          reviews: v.reviews,
          averageRating: Math.round((v.ratingSum / v.reviews) * 100) / 100,
        })),
        agreement: {
          averageKappa: agreement.averageKappa === null ? null : Math.round(agreement.averageKappa * 1000) / 1000,
          interpretation: interpretKappa(agreement.averageKappa),
          pairs: agreement.pairs.map((p) => ({
            reviewerA: names.get(p.reviewerA),
            reviewerB: names.get(p.reviewerB),
            sharedTasks: p.sharedTasks,
            percentAgreement: p.percentAgreement,
            kappa: p.kappa === null ? null : Math.round(p.kappa * 1000) / 1000,
          })),
        },
      });
    }),
  );

  router.get(
    '/:id/export.csv',
    requireRole('admin', 'viewer'),
    wrap(async (req, res) => {
      const id = uuid.parse(req.params.id);
      const project = await getProject(id);
      const { rows } = await pool.query(
        `SELECT t.id, t.prompt, t.response, t.status, u.email AS reviewer, r.rating, r.verdict, r.notes
           FROM tasks t LEFT JOIN reviews r ON r.task_id = t.id LEFT JOIN users u ON u.id = r.reviewer_id
          WHERE t.project_id = $1 ORDER BY t.seq, u.email`,
        [id],
      );
      const csv = toCsv(
        ['task_id', 'prompt', 'response', 'status', 'reviewer', 'rating', 'verdict', 'notes'],
        rows.map((r) => [r.id, r.prompt, r.response, r.status, r.reviewer, r.rating, r.verdict, r.notes]),
      );
      const safeName = String(project.name).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName || 'project'}-reviews.csv"`);
      res.send(csv);
    }),
  );

  return router;
}
