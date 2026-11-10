import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import type { Config } from '../config.js';
import { wrap } from '../errors.js';
import { authenticate, requireRole } from '../middleware/auth.js';

export function auditRouter(pool: pg.Pool, config: Config): Router {
  const router = Router();
  router.use(authenticate(config), requireRole('admin'));
  router.get(
    '/',
    wrap(async (req, res) => {
      const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
      const { rows } = await pool.query(
        `SELECT a.id, a.action, a.entity, a.entity_id, a.meta, a.created_at, u.email AS actor_email
           FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
          ORDER BY a.id DESC LIMIT $1`,
        [limit],
      );
      res.json({ items: rows });
    }),
  );
  return router;
}
