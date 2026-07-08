import { Router } from 'express';
import { db } from '../db/index.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { signToken } from '../auth/token.js';
import { requireAuth } from '../auth/middleware.js';
import { AUTH_COOKIE, authCookieOptions, clearAuthCookieOptions } from '../auth/cookie.js';

export const authRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  base_currency: string;
  created_at: Date;
}

/** Public shape of a user — never includes password_hash. */
function publicUser(user: Pick<UserRow, 'id' | 'email' | 'base_currency'>) {
  return { id: user.id, email: user.email, base_currency: user.base_currency };
}

authRouter.post('/register', async (req, res) => {
  const body = (req.body ?? {}) as {
    email?: unknown;
    password?: unknown;
    base_currency?: unknown;
  };

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!EMAIL_RE.test(email)) {
    res.status(400).json({ error: 'invalid_email' });
    return;
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ error: 'password_too_short' });
    return;
  }

  let baseCurrency = 'EUR';
  if (typeof body.base_currency === 'string' && body.base_currency.trim() !== '') {
    const candidate = body.base_currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(candidate)) {
      res.status(400).json({ error: 'invalid_base_currency' });
      return;
    }
    baseCurrency = candidate;
  }

  const existing = await db<UserRow>('users').where({ email }).first('id');
  if (existing) {
    res.status(409).json({ error: 'email_taken' });
    return;
  }

  const password_hash = await hashPassword(password);
  const [id] = await db('users').insert({
    email,
    password_hash,
    base_currency: baseCurrency,
  });

  const userId = Number(id);
  res.cookie(AUTH_COOKIE, signToken(userId), authCookieOptions);
  res.status(201).json(publicUser({ id: userId, email, base_currency: baseCurrency }));
});

authRouter.post('/login', async (req, res) => {
  const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  const user = await db<UserRow>('users').where({ email }).first();

  // Same 401 response for unknown email and wrong password (no enumeration).
  // Always run a verify to keep timing roughly constant even for unknown emails.
  const ok = user
    ? await verifyPassword(password, user.password_hash)
    : await verifyPassword(password, '$2a$12$0000000000000000000000000000000000000000000000000000');

  if (!user || !ok) {
    res.status(401).json({ error: 'invalid_credentials' });
    return;
  }

  res.cookie(AUTH_COOKIE, signToken(user.id), authCookieOptions);
  res.json(publicUser(user));
});

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(AUTH_COOKIE, clearAuthCookieOptions);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await db<UserRow>('users')
    .where({ id: req.userId })
    .first('id', 'email', 'base_currency', 'created_at');

  if (!user) {
    // Token was valid but the user no longer exists.
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  res.json(user);
});
