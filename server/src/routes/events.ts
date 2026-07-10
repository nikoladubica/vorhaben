import { Router } from 'express';
import type { Knex } from 'knex';
import { db } from '../db/index.js';
import { assertProjectOwned } from '../domain/ownership.js';

// Events (§ voice-capture, step 5). Mounted at /api/events behind requireAuth. A titled entry at a
// specific point in time; unlike reminders, starts_at is REQUIRED. Every row is scoped by
// req.userId; project_id is nullable. Soft-delete only.
export const eventsRouter = Router();

interface EventRow {
  id: number;
  project_id: number | null;
  title: string;
  starts_at: string; // DATE_FORMAT'd wall-clock string
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

// starts_at is DATE_FORMAT'd to the exact stored wall-clock digits (see reminders.ts for the
// rationale — keeps datetime-local values stable across the connection timezone).
function eventSelect(executor: Knex | Knex.Transaction) {
  return executor('events').select<EventRow[]>(
    'id',
    'project_id',
    'title',
    executor.raw("DATE_FORMAT(starts_at, '%Y-%m-%dT%H:%i:%s') as starts_at"),
    'source_transcript',
    'created_at',
    'updated_at',
  );
}

// Accepts "YYYY-MM-DDTHH:MM(:SS)?" (T or space); returns the normalized MariaDB datetime string
// preserving the literal wall-clock. Unlike reminders' remind_at, an event's starts_at is required,
// so null is NOT a valid value here — the caller treats a null/absent input as a validation error.
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

function normalizeStartsAt(raw: unknown): { ok: true; value: string } | { ok: false } {
  if (typeof raw !== 'string') return { ok: false };
  const m = DATETIME_RE.exec(raw.trim());
  if (!m) return { ok: false };
  const [, y, mo, d, h, mi, s] = m;
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

// POST /api/events — { title, starts_at, project_id?, source_transcript? }. Missing/invalid
// starts_at is a 422.
eventsRouter.post('/', async (req, res) => {
  const userId = req.userId as number;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fields: Record<string, string> = {};

  let title = '';
  if (typeof body.title !== 'string' || body.title.trim() === '' || body.title.trim().length > 255) {
    fields.title = 'invalid';
  } else {
    title = body.title.trim();
  }

  const startsAt = normalizeStartsAt(body.starts_at);
  if (!startsAt.ok) fields.starts_at = 'invalid';

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

  const [id] = await db('events').insert({
    user_id: userId,
    project_id: (project as { value: number | null }).value,
    title,
    starts_at: (startsAt as { value: string }).value,
    source_transcript: sourceTranscript,
    created_at: db.fn.now(),
    updated_at: db.fn.now(),
  });

  const created = await eventSelect(db).where('id', Number(id)).first();
  res.status(201).json(created);
});

// GET /api/events — the user's live events, upcoming first (earliest starts_at first).
eventsRouter.get('/', async (req, res) => {
  const userId = req.userId as number;
  const rows = await eventSelect(db)
    .where('user_id', userId)
    .whereNull('deleted_at')
    .orderBy('starts_at', 'asc')
    .orderBy('id', 'asc');
  res.json(rows);
});

// PATCH /api/events/:id — { title?, starts_at?, project_id? }. A provided starts_at must be a valid
// datetime (it cannot be cleared — an event without a time is not an event).
eventsRouter.patch('/:id', async (req, res) => {
  const userId = req.userId as number;
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const existing = await db('events')
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

  if (hasOwn(body, 'title')) {
    if (typeof body.title !== 'string' || body.title.trim() === '' || body.title.trim().length > 255) {
      fields.title = 'invalid';
    } else {
      update.title = body.title.trim();
    }
  }
  if (hasOwn(body, 'starts_at')) {
    const startsAt = normalizeStartsAt(body.starts_at);
    if (!startsAt.ok) fields.starts_at = 'invalid';
    else update.starts_at = startsAt.value;
  }
  if (hasOwn(body, 'project_id')) {
    const project = await resolveProjectId(userId, body.project_id);
    if (!project.ok) fields.project_id = 'unknown';
    else update.project_id = project.value;
  }

  if (Object.keys(fields).length > 0) {
    res.status(422).json({ error: 'validation', fields });
    return;
  }

  if (Object.keys(update).length > 0) {
    await db('events')
      .where({ id, user_id: userId })
      .update({ ...update, updated_at: db.fn.now() });
  }

  const updated = await eventSelect(db).where('id', id).first();
  res.json(updated);
});

// DELETE /api/events/:id — soft delete.
eventsRouter.delete('/:id', async (req, res) => {
  const userId = req.userId as number;
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const affected = await db('events')
    .where({ id, user_id: userId })
    .whereNull('deleted_at')
    .update({ deleted_at: db.fn.now() });
  if (affected === 0) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.status(204).end();
});
