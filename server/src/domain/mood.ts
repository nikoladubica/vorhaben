import type { Knex } from 'knex';
import { db } from '../db/index.js';
import { FEELINGS, type Feeling } from './constants.js';

// The mood stream's single write helper (breaktrough.md §2.2). Both write paths — the projects
// PATCH (canvas / project page) and POST /api/projects/:id/moods — funnel through recordMood so the
// settling-window rule and the "column and stream never disagree" invariant live in exactly one
// place, never scattered across routes.

// Settling window: changing a project's mood again within this many minutes edits the latest event
// in place (a mis-tap was never data); after it, a change appends. 15 minutes is confirmed in
// breaktrough.md §2.2 — env-overridable (MOOD_SETTLING_WINDOW_MINUTES) but the constant lives here.
const DEFAULT_SETTLING_WINDOW_MINUTES = 15;
const rawWindow = Number(process.env.MOOD_SETTLING_WINDOW_MINUTES);
export const SETTLING_WINDOW_MINUTES =
  Number.isFinite(rawWindow) && rawWindow > 0 ? rawWindow : DEFAULT_SETTLING_WINDOW_MINUTES;

// Which flow produced an event. Closed list, app-validated (the DB column is a plain string).
export const MOOD_SOURCES = ['manual', 'nudge', 'weekly_close'] as const;
export type MoodSource = (typeof MOOD_SOURCES)[number];

export interface RecordMoodOptions {
  note?: string | null;
  sourceTranscript?: string | null;
  source?: MoodSource;
}

export interface RecordMoodResult {
  id: number;
  // 'settled' = edited the latest event in place (inside the window); 'appended' = new row.
  action: 'settled' | 'appended';
}

// A value carries an annotation if it is a non-empty, non-whitespace string. Empty/whitespace notes
// count as "no note" for the settling decision (and are stored as null).
function hasText(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Record a mood change for an owned project. Callers are responsible for verifying ownership first
 * (the routes do). Steps:
 *   1. Validate `value` against FEELINGS (or null = cleared).
 *   2. Settling window: if the project's latest live event is < SETTLING_WINDOW_MINUTES old, carries
 *      no note/transcript, and the incoming change carries no note/transcript → edit that event's
 *      value in place. Otherwise append a new row. A change carrying a note/transcript ALWAYS
 *      appends, even inside the window (nobody annotates a typo).
 *   3. Update projects.feeling to `value` in the SAME transaction — the column and the stream must
 *      never disagree.
 *
 * Pass `executor` to run inside a caller's transaction (the projects PATCH does this, so the whole
 * project update is atomic). Omit it and recordMood opens its own transaction so step 3 stays atomic
 * with the stream write.
 */
export async function recordMood(
  userId: number,
  projectId: number,
  value: Feeling | null,
  opts: RecordMoodOptions = {},
  executor?: Knex | Knex.Transaction,
): Promise<RecordMoodResult> {
  // Defensive validation. The routes already return a user-facing 422; this guards the invariant if
  // recordMood is ever called from elsewhere.
  if (value !== null && !FEELINGS.includes(value)) {
    throw new Error(`recordMood: invalid feeling value "${value}"`);
  }
  const source = opts.source ?? 'manual';
  if (!MOOD_SOURCES.includes(source)) {
    throw new Error(`recordMood: invalid source "${source}"`);
  }

  if (executor) {
    return recordMoodInner(executor, userId, projectId, value, opts, source);
  }
  return db.transaction((trx) => recordMoodInner(trx, userId, projectId, value, opts, source));
}

async function recordMoodInner(
  ex: Knex | Knex.Transaction,
  userId: number,
  projectId: number,
  value: Feeling | null,
  opts: RecordMoodOptions,
  source: MoodSource,
): Promise<RecordMoodResult> {
  const note = hasText(opts.note) ? opts.note : null;
  const sourceTranscript = hasText(opts.sourceTranscript) ? opts.sourceTranscript : null;
  const incomingHasAnnotation = note !== null || sourceTranscript !== null;

  // Load the project's latest live event. within_window is computed in the DB (NOW()) so the
  // decision never depends on app/DB clock skew.
  const latest = (await ex('mood_events')
    .where({ user_id: userId, project_id: projectId })
    .whereNull('deleted_at')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .first(
      'id',
      'note',
      'source_transcript',
      ex.raw('(created_at > (NOW() - INTERVAL ? MINUTE)) as within_window', [
        SETTLING_WINDOW_MINUTES,
      ]),
    )) as
    | { id: number; note: string | null; source_transcript: string | null; within_window: number }
    | undefined;

  const latestHasAnnotation =
    !!latest && (hasText(latest.note) || hasText(latest.source_transcript));

  // Settle onto the LATEST event only (never a stale earlier one): it must exist, be unannotated,
  // still be inside the window, and the incoming change must also be unannotated.
  const canSettle =
    !!latest &&
    !latestHasAnnotation &&
    !incomingHasAnnotation &&
    Number(latest.within_window) === 1;

  let result: RecordMoodResult;
  if (canSettle && latest) {
    // The one sanctioned mutation of an existing event: update value + updated_at in place. Note,
    // source, source_transcript and created_at are left exactly as they were.
    await ex('mood_events').where('id', latest.id).update({ value, updated_at: ex.fn.now() });
    result = { id: latest.id, action: 'settled' };
  } else {
    const [id] = await ex('mood_events').insert({
      user_id: userId,
      project_id: projectId,
      value,
      note,
      source_transcript: sourceTranscript,
      source,
      created_at: ex.fn.now(),
      updated_at: ex.fn.now(),
    });
    result = { id: Number(id), action: 'appended' };
  }

  // Keep the denormalized current value in lockstep with the stream. Scoped by user_id so a
  // cross-tenant projectId can never touch another user's row.
  await ex('projects')
    .where({ id: projectId, user_id: userId })
    .update({ feeling: value, updated_at: ex.fn.now() });

  return result;
}
