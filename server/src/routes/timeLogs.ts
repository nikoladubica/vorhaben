import { Router } from 'express';
import type { Knex } from 'knex';
import { db } from '../db/index.js';
import { assertProjectOwned } from '../domain/ownership.js';

// Two routers: the nested one is mounted alongside projectsRouter at /api/projects and owns
// the `/:id/time-logs` paths; the flat one is mounted at /api/time-logs and owns single-row
// PATCH/DELETE. Both go behind requireAuth in app.ts.
export const projectTimeLogsRouter = Router();
export const timeLogsRouter = Router();

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

// time_logs row as returned by logSelect. `date` is DATE_FORMAT'd to a YYYY-MM-DD string;
// `hours` arrives as a string from mysql2's decimal handling (no float drift).
interface TimeLogRow {
  id: number;
  project_id: number;
  date: string;
  hours: string;
  note: string | null;
  created_at: Date;
}

// Base select: dates formatted to YYYY-MM-DD strings, matching the projects API style.
function logSelect(executor: Knex | Knex.Transaction) {
  return executor('time_logs').select<TimeLogRow[]>(
    'id',
    'project_id',
    executor.raw("DATE_FORMAT(date, '%Y-%m-%d') as date"),
    'hours',
    'note',
    'created_at',
  );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

// Hours travel as JSON strings ("7.5") to avoid float drift, but a plain JSON number is also
// accepted. Returns a finite number or null when the value cannot be parsed. Range
// (0 < hours <= 168) is enforced by the caller.
function parseHours(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

// DB-column values produced by a valid request. On PATCH only provided keys are set. `hours`
// is kept as the original string when supplied that way so "7.5" round-trips exactly through
// the decimal column.
interface ValidatedLogColumns {
  date?: string;
  hours?: string | number;
  note?: string | null;
}

type LogValidationResult =
  | { ok: true; value: ValidatedLogColumns }
  | { ok: false; fields: Record<string, string> };

/**
 * Validate a create (partial=false) or update (partial=true) request body. On PATCH only
 * provided fields are validated. `date` and `hours` are NOT-NULL columns, so an explicit null
 * for either is rejected. `hours` must be strictly greater than 0 and at most 168.
 */
function validateLogInput(
  body: Record<string, unknown>,
  partial: boolean,
): LogValidationResult {
  const fields: Record<string, string> = {};
  const columns: ValidatedLogColumns = {};
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

  // hours (0 < hours <= 168) ---------------------------------------------
  if (provided('hours')) {
    const parsed = parseHours(body.hours);
    if (parsed === null || parsed <= 0 || parsed > 168) {
      fields.hours = 'invalid';
    } else {
      // Preserve an incoming string verbatim so "7.5" survives the decimal round-trip; a JSON
      // number is passed through as-is (mysql2 stringifies it into the decimal column).
      columns.hours = typeof body.hours === 'string' ? body.hours.trim() : parsed;
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
// Nested routes: /api/projects/:id/time-logs  (mounted alongside projectsRouter)
// ---------------------------------------------------------------------------

// GET /api/projects/:id/time-logs — newest first, optional ?from=&to= (inclusive).
projectTimeLogsRouter.get('/:id/time-logs', async (req, res) => {
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

  const query = logSelect(db).where('project_id', id);
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

// POST /api/projects/:id/time-logs — create a time log on an owned project.
projectTimeLogsRouter.post('/:id/time-logs', async (req, res) => {
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
  const result = validateLogInput(body, false);
  if (!result.ok) {
    res.status(422).json({ error: 'validation', fields: result.fields });
    return;
  }

  const [logId] = await db('time_logs').insert({
    project_id: id,
    date: result.value.date,
    hours: result.value.hours,
    note: result.value.note ?? null,
  });

  const created = await logSelect(db).where('id', Number(logId)).first();
  res.status(201).json(created);
});

// ---------------------------------------------------------------------------
// Flat routes: /api/time-logs/:id  (ownership via join to projects)
// ---------------------------------------------------------------------------

// Confirm a time log belongs to an owned, non-soft-deleted project. Returns the log id or
// undefined (→ 404). Reads and writes on a soft-deleted project both 404.
async function findOwnedTimeLogId(
  userId: number,
  logId: number,
): Promise<number | undefined> {
  const row = await db('time_logs as t')
    .join('projects as p', 'p.id', 't.project_id')
    .where('t.id', logId)
    .andWhere('p.user_id', userId)
    .whereNull('p.deleted_at')
    .first('t.id as id');
  return row ? Number((row as { id: number }).id) : undefined;
}

// PATCH /api/time-logs/:id — partial update; ownership flows through the project.
timeLogsRouter.patch('/:id', async (req, res) => {
  const userId = req.userId as number;
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const ownedId = await findOwnedTimeLogId(userId, id);
  if (ownedId === undefined) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = validateLogInput(body, true);
  if (!result.ok) {
    res.status(422).json({ error: 'validation', fields: result.fields });
    return;
  }

  // Empty patch: nothing to change (Knex rejects an empty update), return the current row.
  if (Object.keys(result.value).length > 0) {
    await db('time_logs').where('id', id).update(result.value);
  }

  const updated = await logSelect(db).where('id', id).first();
  res.json(updated);
});

// DELETE /api/time-logs/:id — hard delete is allowed: time logs are user-corrected data
// points, not history-bearing records like projects.
timeLogsRouter.delete('/:id', async (req, res) => {
  const userId = req.userId as number;
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const ownedId = await findOwnedTimeLogId(userId, id);
  if (ownedId === undefined) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  await db('time_logs').where('id', id).del();
  res.status(204).end();
});
