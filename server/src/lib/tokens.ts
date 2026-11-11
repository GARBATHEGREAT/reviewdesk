import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Config } from '../config.js';

export type Role = 'admin' | 'reviewer' | 'viewer';

export interface AccessClaims {
  sub: string;
  role: Role;
  email: string;
}

export function signAccessToken(config: Config, claims: AccessClaims): string {
  return jwt.sign({ role: claims.role, email: claims.email }, config.JWT_SECRET, {
    subject: claims.sub,
    expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
    algorithm: 'HS256',
  });
}

export function verifyAccessToken(config: Config, token: string): AccessClaims {
  const payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
  return { sub: String(payload.sub), role: payload.role as Role, email: String(payload.email) };
}

/** Refresh tokens are random strings; only their SHA-256 hash is stored. */
export function newRefreshToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(48).toString('hex');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
