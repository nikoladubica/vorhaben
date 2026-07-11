import { Router } from 'express';
import { db } from '../db/index.js';
import { getUsageState, getInvoiceScanUsage, resolveStoredByokKey } from '../llm/gateway.js';

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

// GET /api/account/usage — the hosted-assistant meter (ticket 12, marketing-strategy §3.5).
// Returns the month-to-date state as a PERCENTAGE plus booleans and the reset instant — never a raw
// token count. The response shape itself enforces the presentation rule: there is no field a token
// number could hide in. `warning` at ≥80%, `capped` once the general budget is spent (chat pauses;
// voice capture keeps working from the reserve, then the rules parser). The client gates the whole
// meter on GET /api/voice/capabilities (llm boolean) so self-host instances with no platform key
// show nothing; this endpoint still answers (percent 0) for a keyless instance.
accountRouter.get('/usage', async (req, res) => {
  const userId = req.userId as number;
  const state = await getUsageState(userId);

  // Invoice-scan fair-use counter (ticket 14, step 5). Scan COUNTS are user-facing — unlike raw
  // tokens, "14 of 100 scans this month" is a unit users understand — so the no-raw-numbers rule
  // (tokens only) does not apply here. BYOK users are uncapped, so their counter is null.
  const hasByok = Boolean(await resolveStoredByokKey(userId));
  const scans = hasByok ? null : await getInvoiceScanUsage(userId);

  res.json({ ...state, scans });
});
