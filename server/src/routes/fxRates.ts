import { Router } from 'express';
import { db } from '../db/index.js';

// Mounted at /api/fx-rates behind requireAuth (see app.ts).
//
// fx_rates rows are GLOBAL (no user_id) but are written through a user's lens: base_currency is
// always taken from the caller's users.base_currency, never from the request body. Two users
// sharing a base currency therefore share (and can overwrite) each other's rates — accepted and
// intended for v1; rates are reference data, not personal data.
export const fxRatesRouter = Router();

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

// fx_rates row as returned by rateSelect. `as_of` is DATE_FORMAT'd to a YYYY-MM-DD string;
// `rate` arrives as a string from mysql2's decimal handling (no float drift).
interface RateRow {
  currency: string;
  base_currency: string;
  rate: string;
  as_of: string;
  created_at: Date;
}

// Base select: as_of formatted to a YYYY-MM-DD string, matching the entries/projects API style.
function rateSelect(baseCurrency: string) {
  return db('fx_rates')
    .where('base_currency', baseCurrency)
    .select<RateRow[]>(
      'currency',
      'base_currency',
      'rate',
      db.raw("DATE_FORMAT(as_of, '%Y-%m-%d') as as_of"),
      'created_at',
    );
}

// ---------------------------------------------------------------------------
// Validation (idioms shared with incomeEntries.ts)
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  // Reject impossible calendar dates (e.g. 2026-02-30) that Date would roll over.
  return date.toISOString().slice(0, 10) === value;
}

function hasOwn(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

// Rates travel as JSON strings ("1.23456789") to avoid float drift, but a plain JSON number is
// also accepted. Returns a finite number > 0, or null when the value cannot be parsed.
function parseRate(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// Resolve the caller's base currency from users.base_currency (char(3), default 'EUR').
async function callerBaseCurrency(userId: number): Promise<string> {
  const user = await db('users').where('id', userId).first('base_currency');
  return (user as { base_currency: string }).base_currency;
}

// Server "today" as a YYYY-MM-DD string (default as_of).
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /api/fx-rates — every rate for the caller's base currency, newest as_of per currency
// first.
fxRatesRouter.get('/', async (req, res) => {
  const userId = req.userId as number;
  const baseCurrency = await callerBaseCurrency(userId);

  const rows = await rateSelect(baseCurrency)
    .orderBy('currency')
    .orderBy('as_of', 'desc');
  res.json(rows);
});

// PUT /api/fx-rates — upsert one rate for the caller's base currency.
// Body: { currency, rate, as_of? }. base_currency is ALWAYS the caller's base, never the body.
fxRatesRouter.put('/', async (req, res) => {
  const userId = req.userId as number;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fields: Record<string, string> = {};

  const currency = body.currency;
  if (typeof currency !== 'string' || !CURRENCY_RE.test(currency)) {
    fields.currency = 'invalid';
  }

  const rate = parseRate(body.rate);
  if (rate === null) {
    fields.rate = 'invalid';
  }

  let asOf = today();
  if (hasOwn(body, 'as_of') && body.as_of !== null && body.as_of !== undefined) {
    if (typeof body.as_of !== 'string' || !isValidDate(body.as_of)) {
      fields.as_of = 'invalid';
    } else {
      asOf = body.as_of;
    }
  }

  if (Object.keys(fields).length > 0) {
    res.status(422).json({ error: 'validation', fields });
    return;
  }

  const baseCurrency = await callerBaseCurrency(userId);
  // A rate against itself is meaningless (identity is handled without a row in convert()).
  if (currency === baseCurrency) {
    res.status(422).json({ error: 'validation', fields: { currency: 'same_as_base' } });
    return;
  }

  const existing = await db('fx_rates')
    .where({ currency, base_currency: baseCurrency, as_of: asOf })
    .first();

  // Upsert on the composite key (currency, base_currency, as_of).
  await db('fx_rates')
    .insert({ currency, base_currency: baseCurrency, rate, as_of: asOf })
    .onConflict(['currency', 'base_currency', 'as_of'])
    .merge(['rate']);

  const row = await rateSelect(baseCurrency)
    .where({ currency, as_of: asOf })
    .first();
  res.status(existing ? 200 : 201).json(row);
});

// DELETE /api/fx-rates/:currency/:as_of — remove one rate for the caller's base currency.
fxRatesRouter.delete('/:currency/:as_of', async (req, res) => {
  const userId = req.userId as number;
  const { currency, as_of: asOf } = req.params;

  const fields: Record<string, string> = {};
  if (!CURRENCY_RE.test(currency)) fields.currency = 'invalid';
  if (!isValidDate(asOf)) fields.as_of = 'invalid';
  if (Object.keys(fields).length > 0) {
    res.status(422).json({ error: 'validation', fields });
    return;
  }

  const baseCurrency = await callerBaseCurrency(userId);
  const deleted = await db('fx_rates')
    .where({ currency, base_currency: baseCurrency, as_of: asOf })
    .del();

  if (deleted === 0) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.status(204).end();
});
