import { Router } from 'express';
import type pg from 'pg';
import type { Config } from '../config.js';
import { withTransaction } from '../db/pool.js';
import { conflict, notFound, wrap } from '../errors.js';
import { audit } from '../lib/audit.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { roleBody, uuid } from '../schemas.js';

export function usersRouter(pool: pg.Pool, config: Config): Router {
  const router = Router();
  router.use(authenticate(config), requireRole('admin'));

  router.get(
    '/',
    wrap(async (_req, res) => {
      const { rows } = await pool.query(
        'SELECT id, email, name, role, created_at FROM users ORDER BY created_at ASC',
      );
      res.json({ items: rows });
    }),
  );

  router.patch(
    '/:id/role',
    wrap(async (req, res) => {
      const id = uuid.parse(req.params.id);
      const { role } = roleBody.parse(req.body);
      const user = await withTransaction(pool, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(727276)');
        const { rows: current } = await client.query<{ role: string }>('SELECT role FROM users WHERE id = $1', [id]);
        if (!current[0]) throw notFound('User');
        if (current[0].role === 'admin' && role !== 'admin') {
          const { rows } = await client.query<{ n: string }>("SELECT count(*) AS n FROM users WHERE role = 'admin'");
          if (Number(rows[0]?.n) <= 1) throw conflict('LAST_ADMIN', 'There must always be at least one admin');
        }
        const { rows } = await client.query(
          'UPDATE users SET role = $2, updated_at = now() WHERE id = $1 RETURNING id, email, name, role',
          [id, role],
        );
        await audit(client, req.user!.id, 'user.role_changed', 'user', id, { from: current[0].role, to: role });
        return rows[0];
      });
      res.json({ user });
    }),
  );

  return router;
}
