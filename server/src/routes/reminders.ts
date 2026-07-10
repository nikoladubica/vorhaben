import { Router } from 'express';
import type { Knex } from 'knex';
import { db } from '../db/index.js';
import { assertProjectOwned } from '../domain/ownership.js';

// Reminders (§ voice-capture, step 5). Mounted at /api/reminders behind requireAuth. ONE table and
// ONE POST endpoint serve both entry paths: the voice review flow (sends source_transcript) and
// the manual "New reminder" form (omits it → NULL). Every row is scoped by req.userId; project_id
// is nullable; remind_at is nullable (an undated "remind me to invoice" is legal). status is a
// plain string validated in the app against a closed list — never a DB enum. Soft-delete only.
export const remindersRouter = Router();

// The closed status list. Adding a status here is the ONLY change needed — no schema migration
// (the column is a plain string, not a native enum).
const REMINDER_STATUSES = ['pending', 'done', 'dismissed'] as const;
type ReminderStatus = (typeof REMINDER_STATUSES)[number];

interface ReminderRow {
  id: number;
  project_id: number | null;
  text: string;
  remind_at: string | null; // DATE_FORMAT'd wall-clock string, or null
  status: string;
  source_transcript: string | null;
  created_at: Date;
  updated_at: Date;
}

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

function hasOwn(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

// remind_at / starts_at are DATE_FORMAT'd back to the exact wall-clock digits that were stored
// ("2026-07-10T17:00:00"), NOT returned as JS Date objects — that keeps the client's datetime-local
// value stable regardless of the connection timezone (same reasoning as the projects route's
// DATE_FORMAT on its DATE columns).
function reminderSelect(executor: Knex | Knex.Transaction) {
  return executor('reminders').select<ReminderRow[]>(
    'id',
    'project_id',
    'text',
    executor.raw("DATE_FORMAT(remind_at, '%Y-%m-%dT%H:%i:%s') as remind_at"),
    'status',
    'source_transcript',
    'created_at',
    'updated_at',
  );
}

// Validate a datetime body field (remind_at). Accepts an ISO-ish local string
// "YYYY-MM-DDTHH:MM(:SS)?" (with 'T' or a space), null/absent → null. Returns the normalized
// MariaDB datetime string "YYYY-MM-DD HH:MM:SS" preserving the literal wall-clock, or an error.
// Deliberately stores wall-clock (no timezone conversion) so a dictated "tomorrow at 5pm" and a
// datetime-local input round-trip unchanged.
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

function normalizeDateTime(
  raw: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false };
  const m = DATETIME_RE.exec(raw.trim());
  if (!m) return { ok: false };
  const [, y, mo, d, h, mi, s] = m;
  // Reject impossible calendar/clock values (e.g. 2026-02-30, 25:00) that would otherwise roll over.
  const probe = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? '0'));
  if (
    probe.getFullYear() !== Number(y) ||
    probe.getMonth() !== Number(mo) - 1 ||
    probe.getDate() !== Number(d) ||
    probe.getHours() !== Number(h) ||
    probe.getMinutes() !== Number(mi)
  ) {
    return { ok: false };
  }
  return { ok: true, value: `${y}-${mo}-${d} ${h}:${mi}:${s ?? '00'}` };
}

async function resolveProjectId(
  userId: number,
  raw: unknown,
): Promise<{ ok: true; value: number | null } | { ok: false }> {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) return { ok: false };
  const owned = await assertProjectOwned(userId, raw);
  return owned ? { ok: true, value: raw } : { ok: false };
}

// POST /api/reminders — { text, remind_at?, project_id?, source_transcript? }. text is required
// (1–1000 after trim); everything else is nullable. Serves both the voice flow and the manual form.
remindersRouter.post('/', async (req, res) => {
  const userId = req.userId as number;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fields: Record<string, string> = {};

  let text = '';
  if (typeof body.text !== 'string' || body.text.trim() === '' || body.text.trim().length > 1000) {
    fields.text = 'invalid';
  } else {
    text = body.text.trim();
  }

  const remindAt = normalizeDateTime(body.remind_at);
  if (!remindAt.ok) fields.remind_at = 'invalid';

  let sourceTranscript: string | null = null;
  if (hasOwn(body, 'source_transcript') && body.source_transcript !== null) {
    if (typeof body.source_transcript !== 'string' || body.source_transcript.length > 10_000) {
      fields.source_transcript = 'invalid';
    } else {
      sourceTranscript = body.source_transcript;
    }
  }

  const project = await resolveProjectId(userId, body.project_id);
  if (!project.ok) fields.project_id = 'unknown';

  if (Object.keys(fields).length > 0) {
    res.status(422).json({ error: 'validation', fields });
    return;
  }

  const [id] = await db('reminders').insert({
    user_id: userId,
    project_id: (project as { value: number | null }).value,
    text,
    remind_at: (remindAt as { value: string | null }).value,
    status: 'pending',
    source_transcript: sourceTranscript,
    created_at: db.fn.now(),
    updated_at: db.fn.now(),
  });

  const created = await reminderSelect(db).where('id', Number(id)).first();
  res.status(201).json(created);
});

// GET /api/reminders?status= — the user's live reminders (optionally filtered to one status),
// newest first. An invalid status filter is ignored (returns the unfiltered live set).
remindersRouter.get('/', async (req, res) => {
  const userId = req.userId as number;
  const query = reminderSelect(db).where('user_id', userId).whereNull('deleted_at');

  const { status } = req.query;
  if (typeof status === 'string' && REMINDER_STATUSES.includes(status as ReminderStatus)) {
    query.andWhere('status', status);
  }

  const rows = await query.orderBy('created_at', 'desc').orderBy('id', 'desc');
  res.json(rows);
});

// PATCH /api/reminders/:id — { status?, text?, remind_at? }. status is validated against the closed
// list (422 otherwise). Works identically for voice- and manually-created reminders.
remindersRouter.patch('/:id', async (req, res) => {
  const userId = req.userId as number;
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const existing = await db('reminders')
    .where({ id, user_id: userId })
    .whereNull('deleted_at')
    .first('id');
  if (!existing) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const fields: Record<string, string> = {};
  const update: Record<string, unknown> = {};

  if (hasOwn(body, 'status')) {
    if (typeof body.status !== 'string' || !REMINDER_STATUSES.includes(body.status as ReminderStatus)) {
      fields.status = 'invalid';
    } else {
      update.status = body.status;
    }
  }
  if (hasOwn(body, 'text')) {
    if (typeof body.text !== 'string' || body.text.trim() === '' || body.text.trim().length > 1000) {
      fields.text = 'invalid';
    } else {
      update.text = body.text.trim();
    }
  }
  if (hasOwn(body, 'remind_at')) {
    const remindAt = normalizeDateTime(body.remind_at);
    if (!remindAt.ok) fields.remind_at = 'invalid';
    else update.remind_at = remindAt.value;
  }

  if (Object.keys(fields).length > 0) {
    res.status(422).json({ error: 'validation', fields });
    return;
  }

  if (Object.keys(update).length > 0) {
    await db('reminders')
      .where({ id, user_id: userId })
      .update({ ...update, updated_at: db.fn.now() });
  }

  const updated = await reminderSelect(db).where('id', id).first();
  res.json(updated);
});

// DELETE /api/reminders/:id — soft delete.
remindersRouter.delete('/:id', async (req, res) => {
  const userId = req.userId as number;
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const affected = await db('reminders')
    .where({ id, user_id: userId })
    .whereNull('deleted_at')
    .update({ deleted_at: db.fn.now() });
  if (affected === 0) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.status(204).end();
});
