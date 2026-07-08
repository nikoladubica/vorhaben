import type { Request, Response, NextFunction } from 'express';
import { AUTH_COOKIE } from './cookie.js';
import { verifyToken } from './token.js';

/**
 * Gate a route behind a valid auth cookie. Sets `req.userId` on success,
 * otherwise responds 401 and does not call `next`.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[AUTH_COOKIE] as string | undefined;
  const userId = token ? verifyToken(token) : null;

  if (userId === null) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  req.userId = userId;
  next();
}
