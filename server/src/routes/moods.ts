import { Router } from 'express';
import type { Knex } from 'knex';
import { db } from '../db/index.js';
import { assertProjectOwned } from '../domain/ownership.js';
import { isWritableFeeling, isTrend, type Feeling, type Trend } from '../domain/constants.js';
import {
  recordMood,
  MOOD_SOURCES,
  MOOD_KINDS,
  type MoodSource,
  type MoodKind,
} from '../domain/mood.js';

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
  kind: string;
  created_at: Date;
}

function moodListSelect(executor: Knex | Knex.Transaction) {
  return executor('mood_events').select<MoodListRow[]>(
    'id',
    'value',
    'note',
    'source',
    'kind',
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

// POST /api/projects/:id/moods — { value, note?, kind? } → recordMood with source 'manual'. This is
// the note-carrying path the project page (and later tickets) use; a note always appends a new
// event. `kind` (default 'feeling') selects which question is answered: feeling → a FEELINGS value,
// trend → a TRENDS value, untouched → an explicit "didn't touch it" (no value).
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

  // kind: optional flow marker (feeling | trend | untouched); defaults to feeling. Validated first
  // because it decides how `value` is validated.
  let kind: MoodKind = 'feeling';
  if (hasOwn(body, 'kind') && body.kind !== null && body.kind !== undefined) {
    if (typeof body.kind !== 'string' || !MOOD_KINDS.includes(body.kind as MoodKind)) {
      fields.kind = 'invalid';
    } else {
      kind = body.kind as MoodKind;
    }
  }

  // value: validated per kind. untouched carries no rating — a non-null value is a mismatch (422),
  // an absent/null value is fine. feeling/trend require the key: null clears, otherwise a member of
  // the writable FEELINGS / TRENDS list. Legacy feelings are read-only and rejected here.
  let value: Feeling | Trend | null = null;
  if (kind === 'untouched') {
    if (hasOwn(body, 'value') && body.value !== null && body.value !== undefined) {
      fields.value = 'invalid';
    }
  } else if (!hasOwn(body, 'value')) {
    fields.value = 'required';
  } else if (body.value === null) {
    value = null;
  } else if (typeof body.value !== 'string') {
    fields.value = 'invalid';
  } else if (kind === 'feeling' && !isWritableFeeling(body.value)) {
    fields.value = 'invalid';
  } else if (kind === 'trend' && !isTrend(body.value)) {
    fields.value = 'invalid';
  } else {
    value = body.value as Feeling | Trend;
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

  // source: optional flow marker (manual | nudge | weekly_close). Defaults to 'manual'; the Weekly
  // Close passes 'weekly_close' so the same single write path tags where a mood came from — never a
  // parallel write route. Validated against the closed MOOD_SOURCES list.
  let source: MoodSource = 'manual';
  if (hasOwn(body, 'source') && body.source !== null && body.source !== undefined) {
    if (typeof body.source !== 'string' || !MOOD_SOURCES.includes(body.source as MoodSource)) {
      fields.source = 'invalid';
    } else {
      source = body.source as MoodSource;
    }
  }

  if (Object.keys(fields).length > 0) {
    res.status(422).json({ error: 'validation', fields });
    return;
  }

  const { id: eventId } = await recordMood(userId, id, value, { note, source, kind });

  const created = await moodListSelect(db).where('id', eventId).first();
  res.status(201).json(created);
});

// ---------------------------------------------------------------------------
// Flat routes: /api/moods
// ---------------------------------------------------------------------------

// GET /api/moods/today?tz= — what the user has logged today. `logged` is true when ANY live mood
// event exists today. Coverage is now reported PER kind (ticket 26):
//   projectIds        — feeling-covered projects; KEPT with its original meaning so the not-yet-
//                       updated client keeps working until ticket 27 lands.
//   feelingProjectIds — same list, named explicitly for the new client.
//   trendProjectIds   — projects with a trend check-in today.
//   untouchedProjectIds — projects explicitly marked "didn't touch it" today.
// An `untouched` event answers BOTH questions, so it counts a project as covered for feeling AND
// trend (it is the Weekly Close catch-up answer — the user has addressed the project). `tz` is an
// optional signed minute offset from UTC (e.g. 120 for UTC+2) so "today" matches the user's wall
// clock; omitted → server date (v1 acceptable per the ticket). Clamped to a real-world range.
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
  // app/DB clock skew. Pull (project_id, kind) pairs so coverage can be split per question.
  const rows = await db('mood_events')
    .where('user_id', userId)
    .whereNull('deleted_at')
    .whereRaw('DATE(created_at + INTERVAL ? MINUTE) = DATE(NOW() + INTERVAL ? MINUTE)', [tz, tz])
    .distinct('project_id', 'kind');

  const feelingSet = new Set<number>();
  const trendSet = new Set<number>();
  const untouchedSet = new Set<number>();
  for (const r of rows as Array<{ project_id: number; kind: string }>) {
    if (r.kind === 'untouched') {
      // An untouched answer addresses both questions for the day.
      untouchedSet.add(r.project_id);
      feelingSet.add(r.project_id);
      trendSet.add(r.project_id);
    } else if (r.kind === 'trend') {
      trendSet.add(r.project_id);
    } else {
      // 'feeling' (the column default, so any legacy/unknown kind counts here too).
      feelingSet.add(r.project_id);
    }
  }

  const feelingProjectIds = [...feelingSet];
  res.json({
    logged: rows.length > 0,
    // Backward-compatible field: feeling-covered projects, as before ticket 26.
    projectIds: feelingProjectIds,
    feelingProjectIds,
    trendProjectIds: [...trendSet],
    untouchedProjectIds: [...untouchedSet],
  });
});
