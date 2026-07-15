import type { Knex } from 'knex';
import { db } from '../db/index.js';
import { isWritableFeeling, isTrend, type Feeling, type Trend } from './constants.js';

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

// Which of the two prompted questions (or the explicit "didn't touch it") an event answers
// (ticket 26). Closed list, app-validated, mirrors MOOD_SOURCES (the DB column is a plain string):
//   feeling   — "How do you feel about it?" → value is a FEELINGS member (or null = cleared)
//   trend     — "How is it going?"          → value is a TRENDS member   (or null = cleared)
//   untouched — an explicit "I didn't touch it" answer → value is always null (it is not a rating)
export const MOOD_KINDS = ['feeling', 'trend', 'untouched'] as const;
export type MoodKind = (typeof MOOD_KINDS)[number];

export interface RecordMoodOptions {
  note?: string | null;
  sourceTranscript?: string | null;
  source?: MoodSource;
  // Which question this event answers. Defaults to 'feeling' so existing callers compile unchanged.
  kind?: MoodKind;
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

// Defensive per-kind value validation (the routes already return a user-facing 422; this guards the
// invariant if recordMood is ever called from elsewhere). feeling → a WRITABLE feeling or null
// (legacy feelings are read-only, never accepted on a write); trend → a TREND or null; untouched →
// null only (it is not a rating).
function validateValueForKind(kind: MoodKind, value: Feeling | Trend | null): void {
  if (kind === 'untouched') {
    if (value !== null) {
      throw new Error(`recordMood: an untouched event carries no value (got "${value}")`);
    }
    return;
  }
  if (value === null) return; // clearing is valid for both rating kinds
  if (kind === 'feeling') {
    if (!isWritableFeeling(value)) {
      throw new Error(`recordMood: invalid feeling value "${value}"`);
    }
    return;
  }
  // kind === 'trend'
  if (!isTrend(value)) {
    throw new Error(`recordMood: invalid trend value "${value}"`);
  }
}

/**
 * Record a check-in for an owned project. Callers are responsible for verifying ownership first
 * (the routes do). Steps:
 *   1. Validate `value` for `kind` (feeling → FEELINGS/null; trend → TRENDS/null; untouched → null).
 *   2. Settling window, PER (project, kind): if the project's latest live event OF THIS KIND is
 *      < SETTLING_WINDOW_MINUTES old, carries no note/transcript, and the incoming change carries no
 *      note/transcript → edit that event's value in place. Otherwise append a new row. A change
 *      carrying a note/transcript ALWAYS appends (nobody annotates a typo). A trend change never
 *      settles onto a feeling event or vice versa — the window is scoped to the kind.
 *   3. Lockstep column, PER kind, in the SAME transaction — feeling → projects.feeling, trend →
 *      projects.trend, untouched → neither column. The denormalized column and its stream must never
 *      disagree.
 *
 * Pass `executor` to run inside a caller's transaction (the projects PATCH does this, so the whole
 * project update is atomic). Omit it and recordMood opens its own transaction so step 3 stays atomic
 * with the stream write.
 */
export async function recordMood(
  userId: number,
  projectId: number,
  value: Feeling | Trend | null,
  opts: RecordMoodOptions = {},
  executor?: Knex | Knex.Transaction,
): Promise<RecordMoodResult> {
  const kind = opts.kind ?? 'feeling';
  if (!MOOD_KINDS.includes(kind)) {
    throw new Error(`recordMood: invalid kind "${kind}"`);
  }
  validateValueForKind(kind, value);
  const source = opts.source ?? 'manual';
  if (!MOOD_SOURCES.includes(source)) {
    throw new Error(`recordMood: invalid source "${source}"`);
  }

  if (executor) {
    return recordMoodInner(executor, userId, projectId, value, opts, source, kind);
  }
  return db.transaction((trx) =>
    recordMoodInner(trx, userId, projectId, value, opts, source, kind),
  );
}

async function recordMoodInner(
  ex: Knex | Knex.Transaction,
  userId: number,
  projectId: number,
  value: Feeling | Trend | null,
  opts: RecordMoodOptions,
  source: MoodSource,
  kind: MoodKind,
): Promise<RecordMoodResult> {
  const note = hasText(opts.note) ? opts.note : null;
  const sourceTranscript = hasText(opts.sourceTranscript) ? opts.sourceTranscript : null;
  const incomingHasAnnotation = note !== null || sourceTranscript !== null;

  // Load the project's latest live event OF THIS KIND. within_window is computed in the DB (NOW())
  // so the decision never depends on app/DB clock skew. Scoping by kind is what keeps a trend change
  // from settling onto a feeling event (and vice versa) — each kind has its own settling window.
  const latest = (await ex('mood_events')
    .where({ user_id: userId, project_id: projectId, kind })
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
      kind,
      created_at: ex.fn.now(),
      updated_at: ex.fn.now(),
    });
    result = { id: Number(id), action: 'appended' };
  }

  // Keep the denormalized current value in lockstep with the stream, PER kind: a feeling event
  // updates projects.feeling, a trend event updates projects.trend, an untouched event touches
  // neither column (it is not a rating — nothing to denormalize). Scoped by user_id so a
  // cross-tenant projectId can never touch another user's row.
  if (kind === 'feeling') {
    await ex('projects')
      .where({ id: projectId, user_id: userId })
      .update({ feeling: value, updated_at: ex.fn.now() });
  } else if (kind === 'trend') {
    await ex('projects')
      .where({ id: projectId, user_id: userId })
      .update({ trend: value, updated_at: ex.fn.now() });
  }

  return result;
}
