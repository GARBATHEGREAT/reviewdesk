import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Config } from '../config.js';
import { forbidden, unauthorized } from '../errors.js';
import { type Role, verifyAccessToken } from '../lib/tokens.js';

export interface AuthUser {
  id: string;
  role: Role;
  email: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

export function authenticate(config: Config): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return next(unauthorized());
    try {
      const claims = verifyAccessToken(config, header.slice(7));
      req.user = { id: claims.sub, role: claims.role, email: claims.email };
      next();
    } catch {
      next(unauthorized('Invalid or expired token'));
    }
  };
}

/** Allow only the listed roles. Must run after authenticate(). */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}
