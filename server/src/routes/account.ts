import { Router } from 'express';
import { db } from '../db/index.js';

// Mounted at /api/account behind requireAuth (see app.ts). Owns the current user's own-account
// settings; the id always comes from the auth token (req.userId), never the request body.
export const accountRouter = Router();

const CURRENCY_RE = /^[A-Z]{3}$/;

interface UserRow {
  id: number;
  email: string;
  base_currency: string;
}

/** Public shape of a user — mirrors auth.ts, never includes password_hash. */
function publicUser(user: UserRow) {
  return { id: user.id, email: user.email, base_currency: user.base_currency };
}

// PATCH /api/account — change the caller's base_currency. Existing fx_rates rows are keyed by the
// base they were entered against and are deliberately left in place: after a base switch they go
// unused rather than being rewritten, so no historical rate is silently reinterpreted.
accountRouter.patch('/', async (req, res) => {
  const userId = req.userId as number;
  const body = (req.body ?? {}) as { base_currency?: unknown };

  // base_currency: required, trimmed + upper-cased, exactly three A–Z letters. Same 400 shape as
  // auth.ts's register handler for a missing/non-string value as for a malformed one.
  if (typeof body.base_currency !== 'string') {
    res.status(400).json({ error: 'invalid_base_currency' });
    return;
  }
  const baseCurrency = body.base_currency.trim().toUpperCase();
  if (!CURRENCY_RE.test(baseCurrency)) {
    res.status(400).json({ error: 'invalid_base_currency' });
    return;
  }

  await db('users').where({ id: userId }).update({ base_currency: baseCurrency });

  // Re-select rather than echo the input, so the response reflects the stored row.
  const user = await db<UserRow>('users')
    .where({ id: userId })
    .first('id', 'email', 'base_currency');
  if (!user) {
    // Token was valid but the user no longer exists.
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  res.json(publicUser(user));
});
