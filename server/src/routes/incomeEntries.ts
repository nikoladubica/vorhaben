import { Router } from 'express';
import type { Knex } from 'knex';
import { db } from '../db/index.js';
import { assertProjectOwned } from '../domain/ownership.js';
import { ensureExpectedEntries, isSalaried } from '../domain/expectedEntries.js';
import { convert, loadRates } from '../domain/fx.js';
import type { CompensationModel } from '../domain/constants.js';

// Two routers: the nested one is mounted alongside projectsRouter at /api/projects and owns
// the `/:id/entries` paths; the flat one is mounted at /api/entries and owns single-entry
// PATCH/DELETE. Both go behind requireAuth in app.ts.
export const projectEntriesRouter = Router();
export const entriesRouter = Router();

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

// income_entries row as returned by entrySelect. `date` is DATE_FORMAT'd to a YYYY-MM-DD
// string; `amount` arrives as a string from mysql2's decimal handling (no float drift).
interface EntryRow {
  id: number;
  project_id: number;
  date: string;
  amount: string;
  currency: string;
  note: string | null;
  source: 'manual' | 'expected';
  created_at: Date;
}

// Base select: dates formatted to YYYY-MM-DD strings, matching the projects API style.
function entrySelect(executor: Knex | Knex.Transaction) {
  return executor('income_entries').select<EntryRow[]>(
    'id',
    'project_id',
    executor.raw("DATE_FORMAT(date, '%Y-%m-%d') as date"),
    'amount',
    'currency',
    'note',
    'source',
    'created_at',
  );
}

// ---------------------------------------------------------------------------
// Validation
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
interface ValidatedEntryColumns {
  date?: string;
  amount?: number;
  currency?: string;
  note?: string | null;
}

type EntryValidationResult =
  { ok: true; value: ValidatedEntryColumns } | { ok: false; fields: Record<string, string> };

/**
 * Validate a create (partial=false) or update (partial=true) request body. On PATCH only
 * provided fields are validated. Currency is only format-checked here; its create-time
 * default (project rate currency → user base currency) is resolved by the POST route, since
 * that needs DB context. `currency`, `amount`, and `date` are NOT-NULL columns, so an explicit
 * null for any of them is rejected.
 */
function validateEntryInput(
  body: Record<string, unknown>,
  partial: boolean,
): EntryValidationResult {
  const fields: Record<string, string> = {};
  const columns: ValidatedEntryColumns = {};
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
// Nested routes: /api/projects/:id/entries  (mounted alongside projectsRouter)
// ---------------------------------------------------------------------------

// GET /api/projects/:id/entries — newest first, optional ?from=&to= (inclusive).
projectEntriesRouter.get('/:id/entries', async (req, res) => {
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

  // Lazily materialize any missing expected entries (salaried projects only; a no-op otherwise)
  // BEFORE selecting, so newly generated rows appear in this (optionally windowed) list.
  await ensureExpectedEntries(id);

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

  const query = entrySelect(db).where('project_id', id);
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

// POST /api/projects/:id/entries — create an entry on an owned project.
projectEntriesRouter.post('/:id/entries', async (req, res) => {
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
  const result = validateEntryInput(body, false);
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

  const [entryId] = await db('income_entries').insert({
    project_id: id,
    date: result.value.date,
    amount: result.value.amount,
    currency,
    note: result.value.note ?? null,
  });

  const created = await entrySelect(db).where('id', Number(entryId)).first();
  res.status(201).json(created);
});

// ---------------------------------------------------------------------------
// Flat routes: /api/entries/:id  (ownership via join to projects)
// ---------------------------------------------------------------------------

// Confirm an entry belongs to an owned, non-soft-deleted project. Returns the entry id or
// undefined (→ 404). Reads and writes on a soft-deleted project both 404.
async function findOwnedEntryId(userId: number, entryId: number): Promise<number | undefined> {
  const row = await db('income_entries as e')
    .join('projects as p', 'p.id', 'e.project_id')
    .where('e.id', entryId)
    .andWhere('p.user_id', userId)
    .whereNull('p.deleted_at')
    .first('e.id as id');
  return row ? Number((row as { id: number }).id) : undefined;
}

// ---------------------------------------------------------------------------
// Cross-project monthly view: GET /api/entries?from=&to=  (income screen, design 11)
// ---------------------------------------------------------------------------

// Two-digit zero-pad for month/day parts.
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// Inclusive first/last calendar day of the UTC month containing `now`, as 'YYYY-MM-DD' strings.
function currentMonthRange(now: Date): { from: string; to: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-based
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return { from: `${y}-${pad2(m + 1)}-01`, to: `${y}-${pad2(m + 1)}-${pad2(lastDay)}` };
}

// Sum a list of fixed-2-decimal base-currency strings into integer cents (no float drift on the
// grand total). Each `converted` amount is already in base currency, so summing them is valid.
function sumCents(values: string[]): number {
  let cents = 0;
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) cents += Math.round(n * 100);
  }
  return cents;
}

interface MonthEntryRow {
  id: number;
  project_id: number;
  date: string;
  amount: string;
  currency: string;
  note: string | null;
  source: 'manual' | 'expected';
}

// GET /api/entries?from=&to= — every income entry across the caller's owned, non-deleted projects
// within the inclusive range (defaults to the current calendar month). Amounts are summed in the
// user's base currency SERVER-SIDE (convert + loadRates, as metrics.ts does) so the client never
// sums mixed currencies. Returns the newest-first entry list, per-project totals + shares, and the
// grand total.
entriesRouter.get('/', async (req, res) => {
  const userId = req.userId as number;

  const def = currentMonthRange(new Date());
  let { from, to } = def;

  const { from: rawFrom, to: rawTo } = req.query;
  const fields: Record<string, string> = {};
  if (typeof rawFrom === 'string' && rawFrom !== '') {
    if (!isValidDate(rawFrom)) fields.from = 'invalid';
    else from = rawFrom;
  }
  if (typeof rawTo === 'string' && rawTo !== '') {
    if (!isValidDate(rawTo)) fields.to = 'invalid';
    else to = rawTo;
  }
  if (Object.keys(fields).length > 0) {
    res.status(422).json({ error: 'validation', fields });
    return;
  }

  // Owned, non-deleted projects only — ownership of entries flows through this set.
  const projects = await db('projects')
    .where('user_id', userId)
    .whereNull('deleted_at')
    .select<Array<{ id: number; name: string; compensation_model: CompensationModel }>>(
      'id',
      'name',
      'compensation_model',
    );

  const user = await db('users').where('id', userId).first('base_currency');
  const baseCurrency = (user as { base_currency: string } | undefined)?.base_currency ?? 'EUR';

  if (projects.length === 0) {
    res.json({ base_currency: baseCurrency, from, to, entries: [], by_project: [], total: '0.00' });
    return;
  }

  // Materialize any missing expected entries for salaried projects (a no-op otherwise) BEFORE the
  // select, so auto-generated salary rows appear in the month like they do on the project screen.
  for (const project of projects) {
    if (isSalaried(project.compensation_model)) {
      await ensureExpectedEntries(project.id);
    }
  }

  const projectIds = projects.map((p) => p.id);
  const nameById = new Map(projects.map((p) => [p.id, p.name]));

  const rows = await db('income_entries')
    .whereIn('project_id', projectIds)
    .andWhere('date', '>=', from)
    .andWhere('date', '<=', to)
    .select<MonthEntryRow[]>(
      'id',
      'project_id',
      db.raw("DATE_FORMAT(date, '%Y-%m-%d') as date"),
      'amount',
      'currency',
      'note',
      'source',
    )
    // Newest first; id as a stable tiebreak within a day.
    .orderBy('date', 'desc')
    .orderBy('id', 'desc');

  const rates = await loadRates(baseCurrency);

  // Convert each entry to base currency at its own date; carry the original amount/currency too.
  const entries = rows.map((row) => {
    const conversion = convert(row.amount, row.currency, baseCurrency, row.date, rates);
    return {
      id: row.id,
      date: row.date,
      project_id: row.project_id,
      name: nameById.get(row.project_id) ?? '',
      note: row.note,
      amount: row.amount,
      currency: row.currency,
      source: row.source,
      converted: conversion.converted,
      missing_rate: conversion.missing_rate,
    };
  });

  const totalCents = sumCents(entries.map((e) => e.converted));

  // Per-project base-currency totals + 0–1 share of the grand total, largest first.
  const centsByProject = new Map<number, number>();
  for (const entry of entries) {
    const prev = centsByProject.get(entry.project_id) ?? 0;
    centsByProject.set(entry.project_id, prev + Math.round(Number(entry.converted) * 100));
  }
  const by_project = [...centsByProject.entries()]
    .map(([project_id, cents]) => ({
      project_id,
      name: nameById.get(project_id) ?? '',
      total: (cents / 100).toFixed(2),
      share: totalCents !== 0 ? cents / totalCents : 0,
    }))
    .sort((a, b) => b.share - a.share);

  res.json({
    base_currency: baseCurrency,
    from,
    to,
    entries,
    by_project,
    total: (totalCents / 100).toFixed(2),
  });
});

// PATCH /api/entries/:id — partial update; currency cannot be defaulted or cleared here.
entriesRouter.patch('/:id', async (req, res) => {
  const userId = req.userId as number;
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const ownedId = await findOwnedEntryId(userId, id);
  if (ownedId === undefined) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = validateEntryInput(body, true);
  if (!result.ok) {
    res.status(422).json({ error: 'validation', fields: result.fields });
    return;
  }

  // Empty patch: nothing to change (Knex rejects an empty update), return the current row.
  if (Object.keys(result.value).length > 0) {
    // Adjusting an entry confirms it: an expected entry the user edits becomes manual so
    // regeneration never touches it again. A manual entry stays manual (no-op).
    await db('income_entries')
      .where('id', id)
      .update({ ...result.value, source: 'manual' });
  }

  const updated = await entrySelect(db).where('id', id).first();
  res.json(updated);
});

// POST /api/entries/:id/confirm — accept an auto-generated expected entry as-is, flipping its
// source to 'manual' so regeneration leaves it alone. A no-op flip on an already-manual entry.
entriesRouter.post('/:id/confirm', async (req, res) => {
  const userId = req.userId as number;
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const ownedId = await findOwnedEntryId(userId, id);
  if (ownedId === undefined) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  await db('income_entries').where('id', id).update({ source: 'manual' });

  const confirmed = await entrySelect(db).where('id', id).first();
  res.json(confirmed);
});

// DELETE /api/entries/:id — hard delete is allowed: entries are user-corrected data points,
// not history-bearing records like projects. Deleting an EXPECTED entry additionally records a
// suppression tombstone so its period is not resurrected on the next generation pass; deleting a
// manual entry just removes it.
entriesRouter.delete('/:id', async (req, res) => {
  const userId = req.userId as number;
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  // Fetch source + project + period date alongside ownership so we know whether to suppress.
  const owned = (await db('income_entries as e')
    .join('projects as p', 'p.id', 'e.project_id')
    .where('e.id', id)
    .andWhere('p.user_id', userId)
    .whereNull('p.deleted_at')
    .first(
      'e.id as id',
      'e.source as source',
      'e.project_id as project_id',
      db.raw("DATE_FORMAT(e.date, '%Y-%m-%d') as date"),
    )) as
    { id: number; source: 'manual' | 'expected'; project_id: number; date: string } | undefined;
  if (owned === undefined) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  if (owned.source === 'expected') {
    // Tombstone the period first; INSERT IGNORE keeps a repeat delete idempotent.
    await db('suppressed_expected_entries')
      .insert({ project_id: owned.project_id, period_date: owned.date })
      .onConflict(['project_id', 'period_date'])
      .ignore();
  }

  await db('income_entries').where('id', id).del();
  res.status(204).end();
});
