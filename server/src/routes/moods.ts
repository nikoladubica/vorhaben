import { Router } from 'express';
import type { Knex } from 'knex';
import { db } from '../db/index.js';
import { assertProjectOwned } from '../domain/ownership.js';
import { FEELINGS, type Feeling } from '../domain/constants.js';
import { recordMood } from '../domain/mood.js';

// Two routers, mirroring the notes split: the nested one mounts alongside projectsRouter at
// /api/projects and owns the `/:id/moods` paths; the flat one mounts at /api/moods and owns
// /moods/today. Both behind requireAuth in app.ts; ownership is enforced per request (the project
// join / assertProjectOwned), so one user can never read or write another user's mood stream.
export const projectMoodsRouter = Router();
export const moodsRouter = Router();

// Public list shape. source_transcript (the raw voice dictation) is deliberately NOT selected here —
// lists never expose it raw; a caller that needs it asks for a single event explicitly.
interface MoodListRow {
  id: number;
  value: string | null;
  note: string | null;
  source: string;
  created_at: Date;
}

function moodListSelect(executor: Knex | Knex.Transaction) {
  return executor('mood_events').select<MoodListRow[]>(
    'id',
    'value',
    'note',
    'source',
    'created_at',
  );
}

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

function hasOwn(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

// How many stream entries a list returns without an explicit ?limit, and the hard ceiling.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseLimit(raw: unknown): number {
  if (typeof raw !== 'string' || raw === '') return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

// ---------------------------------------------------------------------------
// Nested routes: /api/projects/:id/moods  (mounted alongside projectsRouter)
// ---------------------------------------------------------------------------

// GET /api/projects/:id/moods?limit= — the project's stream, newest first.
projectMoodsRouter.get('/:id/moods', async (req, res) => {
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

  const limit = parseLimit(req.query.limit);
  // Scope by user_id as well as project_id (defence in depth on top of the ownership check).
  const rows = await moodListSelect(db)
    .where({ user_id: userId, project_id: id })
    .whereNull('deleted_at')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit);
  res.json(rows);
});

// POST /api/projects/:id/moods — { value, note? } → recordMood with source 'manual'. This is the
// note-carrying path the project page (and later tickets) use; a note always appends a new event.
projectMoodsRouter.post('/:id/moods', async (req, res) => {
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
  const fields: Record<string, string> = {};

  // value: required key; null clears the feeling, otherwise a valid FEELINGS member. Same closed
  // list and 422 shape as the projects PATCH.
  let value: Feeling | null = null;
  if (!hasOwn(body, 'value')) {
    fields.value = 'required';
  } else if (body.value === null) {
    value = null;
  } else if (typeof body.value !== 'string' || !FEELINGS.includes(body.value as Feeling)) {
    fields.value = 'invalid';
  } else {
    value = body.value as Feeling;
  }

  // note: optional one-line "why?", stored verbatim (never rewritten). Whitespace-only → no note.
  let note: string | null = null;
  if (hasOwn(body, 'note') && body.note !== null && body.note !== undefined) {
    if (typeof body.note !== 'string' || body.note.length > 1000) {
      fields.note = 'invalid';
    } else if (body.note.trim() !== '') {
      note = body.note;
    }
  }

  if (Object.keys(fields).length > 0) {
    res.status(422).json({ error: 'validation', fields });
    return;
  }

  const { id: eventId } = await recordMood(userId, id, value, { note, source: 'manual' });

  const created = await moodListSelect(db).where('id', eventId).first();
  res.status(201).json(created);
});

// ---------------------------------------------------------------------------
// Flat routes: /api/moods
// ---------------------------------------------------------------------------

// GET /api/moods/today?tz= — whether the user has logged ANY live mood event today. Feeds the daily
// nudge (which shows only when logged=false). `tz` is an optional signed minute offset from UTC
// (e.g. 120 for UTC+2) so "today" matches the user's wall clock; omitted → server date (v1
// acceptable per the ticket). Clamped to a real-world range.
const MAX_TZ_OFFSET = 14 * 60; // +14:00, the largest real offset

function parseTzOffset(raw: unknown): number {
  if (typeof raw !== 'string' || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n)) return 0;
  return Math.max(-MAX_TZ_OFFSET, Math.min(MAX_TZ_OFFSET, n));
}

moodsRouter.get('/today', async (req, res) => {
  const userId = req.userId as number;
  const tz = parseTzOffset(req.query.tz);

  // Compare the local calendar date of each event's created_at against the local calendar date of
  // now, both shifted by the same offset — done in the DB so it is one indexed scan and free of
  // app/DB clock skew.
  const row = await db('mood_events')
    .where('user_id', userId)
    .whereNull('deleted_at')
    .whereRaw('DATE(created_at + INTERVAL ? MINUTE) = DATE(NOW() + INTERVAL ? MINUTE)', [tz, tz])
    .first(db.raw('1 as present'));

  res.json({ logged: !!row });
});
