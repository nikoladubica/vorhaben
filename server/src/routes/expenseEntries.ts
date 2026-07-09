import { Router } from 'express';
import type { Knex } from 'knex';
import { db } from '../db/index.js';
import { assertProjectOwned } from '../domain/ownership.js';

// Two routers mirroring incomeEntries.ts: the nested one shares the /api/projects mount and owns
// `/:id/expenses`; the flat one is mounted at /api/expenses and owns single-row PATCH/DELETE. Both
// go behind requireAuth in app.ts. Expenses are ALWAYS user-entered — there is no 'expected'
// source, no confirm route, and no suppression tombstone (BUSINESS_LOGIC.md §8): positive amounts
// simply mean money out. Everything else (validation, currency defaulting, cross-user 404s)
// matches income entries exactly.
export const projectExpensesRouter = Router();
export const expensesRouter = Router();

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

// expense_entries row as returned by expenseSelect. `date` is DATE_FORMAT'd to a YYYY-MM-DD
// string; `amount` arrives as a string from mysql2's decimal handling (no float drift).
interface ExpenseRow {
  id: number;
  project_id: number;
  date: string;
  amount: string;
  currency: string;
  note: string | null;
  created_at: Date;
}

// Base select: dates formatted to YYYY-MM-DD strings, matching the income-entry API style.
function expenseSelect(executor: Knex | Knex.Transaction) {
  return executor('expense_entries').select<ExpenseRow[]>(
    'id',
    'project_id',
    executor.raw("DATE_FORMAT(date, '%Y-%m-%d') as date"),
    'amount',
    'currency',
    'note',
    'created_at',
  );
}

// ---------------------------------------------------------------------------
// Validation (identical rules to income entries, minus the `source` column)
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

// Amounts travel as JSON strings ("240.00") to avoid float drift, but a plain JSON number is
// also accepted. Returns a finite number (negative allowed — refunds/corrections are real) or
// null when the value cannot be parsed.
function parseAmount(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

// DB-column values produced by a valid request. On PATCH only provided keys are set.
interface ValidatedExpenseColumns {
  date?: string;
  amount?: number;
  currency?: string;
  note?: string | null;
}

type ExpenseValidationResult =
  | { ok: true; value: ValidatedExpenseColumns }
  | { ok: false; fields: Record<string, string> };

/**
 * Validate a create (partial=false) or update (partial=true) request body. On PATCH only
 * provided fields are validated. Currency is only format-checked here; its create-time default
 * (project rate currency → user base currency) is resolved by the POST route, since that needs
 * DB context. `currency`, `amount`, and `date` are NOT-NULL columns, so an explicit null for any
 * of them is rejected.
 */
function validateExpenseInput(
  body: Record<string, unknown>,
  partial: boolean,
): ExpenseValidationResult {
  const fields: Record<string, string> = {};
  const columns: ValidatedExpenseColumns = {};
  const provided = (key: string) => (partial ? hasOwn(body, key) : true);

  // date ------------------------------------------------------------------
  if (provided('date')) {
    const raw = body.date;
    if (typeof raw !== 'string' || !isValidDate(raw)) {
      fields.date = 'invalid';
    } else {
      columns.date = raw;
    }
  }

  // amount (negative allowed) --------------------------------------------
  if (provided('amount')) {
    const parsed = parseAmount(body.amount);
    if (parsed === null) {
      fields.amount = 'invalid';
    } else {
      columns.amount = parsed;
    }
  }

  // currency (optional on create → default resolved by caller) -----------
  if (hasOwn(body, 'currency')) {
    const raw = body.currency;
    if (raw === null || raw === undefined) {
      // On create an omitted/null currency means "use the default"; on PATCH the not-null
      // column cannot be cleared.
      if (partial) fields.currency = 'invalid';
    } else if (typeof raw !== 'string' || !CURRENCY_RE.test(raw)) {
      fields.currency = 'invalid';
    } else {
      columns.currency = raw;
    }
  }

  // note (optional free text, nullable) ----------------------------------
  if (provided('note')) {
    const raw = body.note;
    if (raw === null || raw === undefined) {
      columns.note = null;
    } else if (typeof raw !== 'string') {
      fields.note = 'invalid';
    } else if (raw.length > 500) {
      fields.note = 'too_long';
    } else {
      columns.note = raw;
    }
  }

  if (Object.keys(fields).length > 0) {
    return { ok: false, fields };
  }
  return { ok: true, value: columns };
}

// Parse a :id route param to a positive integer, or null when it is not one (→ 404).
function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

// ---------------------------------------------------------------------------
// Nested routes: /api/projects/:id/expenses  (mounted alongside projectsRouter)
// ---------------------------------------------------------------------------

// GET /api/projects/:id/expenses — newest first, optional ?from=&to= (inclusive).
projectExpensesRouter.get('/:id/expenses', async (req, res) => {
  const userId = req.userId as number;
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const project = await assertProjectOwned(userId, id);
  if (!project) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  // Optional date-range filter; malformed bounds are a client error.
  const { from, to } = req.query;
  const fields: Record<string, string> = {};
  if (typeof from === 'string' && from !== '' && !isValidDate(from)) {
    fields.from = 'invalid';
  }
  if (typeof to === 'string' && to !== '' && !isValidDate(to)) {
    fields.to = 'invalid';
  }
  if (Object.keys(fields).length > 0) {
    res.status(422).json({ error: 'validation', fields });
    return;
  }

  const query = expenseSelect(db).where('project_id', id);
  if (typeof from === 'string' && from !== '') {
    query.andWhere('date', '>=', from);
  }
  if (typeof to === 'string' && to !== '') {
    query.andWhere('date', '<=', to);
  }
  // Newest first; id as a stable tiebreak within a day.
  query.orderBy('date', 'desc').orderBy('id', 'desc');

  const rows = await query;
  res.json(rows);
});

// POST /api/projects/:id/expenses — create an expense on an owned project.
projectExpensesRouter.post('/:id/expenses', async (req, res) => {
  const userId = req.userId as number;
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const project = await assertProjectOwned(userId, id);
  if (!project) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = validateExpenseInput(body, false);
  if (!result.ok) {
    res.status(422).json({ error: 'validation', fields: result.fields });
    return;
  }

  // Resolve currency: explicit value → project rate currency → user base currency.
  let currency = result.value.currency ?? project.rate_currency ?? null;
  if (!currency) {
    const user = await db('users').where('id', userId).first('base_currency');
    currency = (user as { base_currency: string }).base_currency;
  }

  const [expenseId] = await db('expense_entries').insert({
    project_id: id,
    date: result.value.date,
    amount: result.value.amount,
    currency,
    note: result.value.note ?? null,
  });

  const created = await expenseSelect(db).where('id', Number(expenseId)).first();
  res.status(201).json(created);
});

// ---------------------------------------------------------------------------
// Flat routes: /api/expenses/:id  (ownership via join to projects)
// ---------------------------------------------------------------------------

// Confirm an expense belongs to an owned, non-soft-deleted project. Returns the row id or
// undefined (→ 404). Reads and writes on a soft-deleted project both 404.
async function findOwnedExpenseId(
  userId: number,
  expenseId: number,
): Promise<number | undefined> {
  const row = await db('expense_entries as e')
    .join('projects as p', 'p.id', 'e.project_id')
    .where('e.id', expenseId)
    .andWhere('p.user_id', userId)
    .whereNull('p.deleted_at')
    .first('e.id as id');
  return row ? Number((row as { id: number }).id) : undefined;
}

// PATCH /api/expenses/:id — partial update; currency cannot be defaulted or cleared here.
expensesRouter.patch('/:id', async (req, res) => {
  const userId = req.userId as number;
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const ownedId = await findOwnedExpenseId(userId, id);
  if (ownedId === undefined) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = validateExpenseInput(body, true);
  if (!result.ok) {
    res.status(422).json({ error: 'validation', fields: result.fields });
    return;
  }

  // Empty patch: nothing to change (Knex rejects an empty update), return the current row.
  if (Object.keys(result.value).length > 0) {
    await db('expense_entries').where('id', id).update(result.value);
  }

  const updated = await expenseSelect(db).where('id', id).first();
  res.json(updated);
});

// DELETE /api/expenses/:id — hard delete: expenses are user-corrected data points, not
// history-bearing records like projects, and there is no expected/suppression concept here.
expensesRouter.delete('/:id', async (req, res) => {
  const userId = req.userId as number;
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const ownedId = await findOwnedExpenseId(userId, id);
  if (ownedId === undefined) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  await db('expense_entries').where('id', id).del();
  res.status(204).end();
});
