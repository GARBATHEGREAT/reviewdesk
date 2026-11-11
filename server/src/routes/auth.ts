import bcrypt from 'bcryptjs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { Config } from '../config.js';
import { type Db, isUniqueViolation, withTransaction } from '../db/pool.js';
import { conflict, unauthorized, wrap } from '../errors.js';
import { audit } from '../lib/audit.js';
import { hashToken, newRefreshToken, signAccessToken, type Role } from '../lib/tokens.js';
import { authenticate } from '../middleware/auth.js';
import { loginBody, registerBody } from '../schemas.js';
import type pg from 'pg';

const COOKIE = 'rd_refresh';

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  password_hash: string;
}

export const publicUser = (u: Pick<UserRow, 'id' | 'email' | 'name' | 'role'>) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
});

export function authRouter(pool: pg.Pool, config: Config): Router {
  const router = Router();
  // Compared against when the email is unknown, so response time does not reveal which emails exist.
  const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', config.BCRYPT_ROUNDS);
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.AUTH_RATE_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' } },
  });

  const cookieOptions = {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: config.NODE_ENV === 'production',
    path: '/api/auth',
    maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  };

  async function issueSession(db: Db, user: UserRow, res: import('express').Response) {
    const { token, hash } = newRefreshToken();
    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
      [user.id, hash, String(config.REFRESH_TOKEN_TTL_DAYS)],
    );
    res.cookie(COOKIE, token, cookieOptions);
    return {
      user: publicUser(user),
      accessToken: signAccessToken(config, { sub: user.id, role: user.role, email: user.email }),
    };
  }

  router.post(
    '/register',
    limiter,
    wrap(async (req, res) => {
      const body = registerBody.parse(req.body);
      const passwordHash = await bcrypt.hash(body.password, config.BCRYPT_ROUNDS);
      try {
        const result = await withTransaction(pool, async (client) => {
          // Serialise registrations so exactly one "first user" becomes admin.
          await client.query('SELECT pg_advisory_xact_lock(727275)');
          const { rows: count } = await client.query<{ n: string }>('SELECT count(*) AS n FROM users');
          const role: Role = Number(count[0]?.n) === 0 ? 'admin' : 'reviewer';
          const { rows } = await client.query<UserRow>(
            `INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING *`,
            [body.email, body.name, passwordHash, role],
          );
          const user = rows[0] as UserRow;
          await audit(client, user.id, 'user.register', 'user', user.id, { role });
          return issueSession(client, user, res);
        });
        res.status(201).json(result);
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
        throw err;
      }
    }),
  );

  router.post(
    '/login',
    limiter,
    wrap(async (req, res) => {
      const body = loginBody.parse(req.body);
      const { rows } = await pool.query<UserRow>('SELECT * FROM users WHERE lower(email) = lower($1)', [body.email]);
      const user = rows[0];
      // Same message for unknown email and wrong password, so accounts cannot be probed.
      const ok = await bcrypt.compare(body.password, user ? user.password_hash : DUMMY_HASH);
      if (!user || !ok) throw unauthorized('Incorrect email or password');
      res.json(await issueSession(pool, user, res));
    }),
  );

  router.post(
    '/refresh',
    wrap(async (req, res) => {
      const token = req.cookies?.[COOKIE] as string | undefined;
      if (!token) throw unauthorized('No session');
      const hash = hashToken(token);
      const result = await withTransaction(pool, async (client) => {
        const { rows } = await client.query<{ id: string; user_id: string; revoked_at: Date | null; expired: boolean }>(
          'SELECT id, user_id, revoked_at, expires_at < now() AS expired FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE',
          [hash],
        );
        const row = rows[0];
        if (!row) return { error: 'Invalid session' } as const;
        if (row.revoked_at) {
          // A used token came back: assume theft and end every session for this user.
          await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [
            row.user_id,
          ]);
          return { error: 'Session no longer valid' } as const;
        }
        if (row.expired) return { error: 'Session expired' } as const;
        await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [row.id]);
        const { rows: users } = await client.query<UserRow>('SELECT * FROM users WHERE id = $1', [row.user_id]);
        const user = users[0];
        if (!user) return { error: 'Invalid session' } as const;
        return { session: await issueSession(client, user, res) } as const;
      });
      if ('error' in result) {
        res.clearCookie(COOKIE, { path: '/api/auth' });
        throw unauthorized(result.error);
      }
      res.json(result.session);
    }),
  );

  router.post(
    '/logout',
    wrap(async (req, res) => {
      const token = req.cookies?.[COOKIE] as string | undefined;
      if (token) {
        await pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [
          hashToken(token),
        ]);
      }
      res.clearCookie(COOKIE, { path: '/api/auth' });
      res.status(204).end();
    }),
  );

  router.get(
    '/me',
    authenticate(config),
    wrap(async (req, res) => {
      const { rows } = await pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [req.user!.id]);
      if (!rows[0]) throw unauthorized();
      res.json({ user: publicUser(rows[0]) });
    }),
  );

  return router;
}
