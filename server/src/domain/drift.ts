// ---------------------------------------------------------------------------
// Drift alerts & the weekly nudge budget (breaktrough.md §2.7, ticket 06)
// ---------------------------------------------------------------------------
//
// Decluttering is permission to stop. Two triggers, one philosophy — the tool whispers, it never
// nags. This module holds BOTH halves, split the same way moodAnalysis.ts ↔ signals.ts split:
//
//   - PURE heuristics (evaluateFeelingDrift / evaluateAttentionDrift / isoWeekPeriod / the budget
//     key) — plain data in, plain data out, no Knex, no clock beyond the `asOf` the caller passes.
//     Tested with fixtures alone in drift.test.ts, exactly like moodAnalysis.
//   - the DB-facing assembler (buildNudgesForUser) — loads each active project's mood stream, last
//     activity and effective rate, runs the pure rules, and enforces the once-per-project-per-kind-
//     per-week budget against the append-only nudge_log meter.
//
// No LLM anywhere; identical self-hosted and hosted. Nudges are observations, not predictions
// (BUSINESS_LOGIC §7): templates, never generated text. Never red, never blocking — the client
// renders these inside the existing Signals panel and nowhere else.

import { db } from '../db/index.js';
import { computeMetricsForUser } from './metrics.js';
import { analyzeMood, type MoodEventInput } from './moodAnalysis.js';
import type { MoodAnalysis } from './moodAnalysis.js';
import type { Feeling } from './constants.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// --- Named thresholds (each explainable in one sentence, per §2.7) ---------

// Attention drift: an active project with no time log, income entry or mood event newer than this
// many days. "~45 days" in the brief; the constant is the contract.
export const ATTENTION_DRIFT_DAYS = 45;

// Feeling drift (streak path): a decline must be at least this many consecutive falling readings —
// "dropped four weeks straight". Sits above moodAnalysis's MIN_STREAK (2): a nudge is a firmer bar
// than a First Signal sentence.
export const FEELING_DRIFT_MIN_STREAK = 4;

// Feeling drift (trend path): a valence slope (trend_score, roughly −4…+4) at or below this counts
// as a decisive slide even without a clean consecutive streak. Named so it is one-sentence
// explainable: "the last few weeks average a full point worse than the weeks before".
export const FEELING_DRIFT_TREND_MAX = -1;

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

export const DRIFT_KINDS = ['feeling_drift', 'attention_drift'] as const;
export type DriftKind = (typeof DRIFT_KINDS)[number];

// The two-axis framing split (the point of ticket 02's two-axis model): a valence slide while the
// fire still burns is STRAIN (contain it, or raise the rate); a fading fire is CHECKED-OUT (the fire
// is going out — maybe an ending). Same trigger, two different recommendations.
export type DriftFraming = 'strain' | 'checked_out';

export interface DriftFinding {
  kind: DriftKind;
  // Only feeling_drift carries a framing; attention_drift is a single guilt-free-ending sentence.
  framing?: DriftFraming;
  sentence: string;
}

export interface FeelingDriftContext {
  name: string;
  // This project sits in the portfolio's bottom rate half (≥2 rated projects) — unlocks the rate
  // pairing clause ("while it earns one of your lowest hourly rates"). A decline on your worst
  // earner is the more actionable one.
  isBottomRateHalf?: boolean;
}

/**
 * Feeling drift: an ESTABLISHED-confidence project whose feeling is decisively sliding, OR whose
 * fire is going out. Returns the nudge finding, or null when there is nothing worth whispering.
 *
 * Fires when established AND any of:
 *   - direction 'down' with a streak of ≥ FEELING_DRIFT_MIN_STREAK falling readings, or
 *   - trend_score at or below FEELING_DRIFT_TREND_MAX (a decisive valence slope), or
 *   - the burnout trajectory: energyDirection 'down' into a 'fading' fire.
 *
 * The sentence differs by AXIS, not by which clause fired: a 'fading' fire reads as checked-out (an
 * ending is on the table); anything else reads as strain (the fire still burns — contain it or raise
 * the rate). This keeps the copy honest about which axis actually moved.
 */
export function evaluateFeelingDrift(
  analysis: MoodAnalysis,
  ctx: FeelingDriftContext,
): DriftFinding | null {
  // The engine does not nudge on thin data — only an established pattern earns a "time to decide".
  if (analysis.confidence !== 'established') return null;

  const burnoutTrajectory = analysis.energyDirection === 'down' && analysis.fire === 'fading';
  const streakDecline =
    analysis.direction === 'down' && analysis.streak >= FEELING_DRIFT_MIN_STREAK;
  const trendDecline = analysis.trendScore <= FEELING_DRIFT_TREND_MAX;

  if (!burnoutTrajectory && !streakDecline && !trendDecline) return null;

  // Framing follows the fire, so the sentence never claims "still burning" when it is not.
  const framing: DriftFraming = analysis.fire === 'fading' ? 'checked_out' : 'strain';
  return {
    kind: 'feeling_drift',
    framing,
    sentence: feelingDriftSentence(ctx.name, framing, ctx.isBottomRateHalf ?? false),
  };
}

function feelingDriftSentence(name: string, framing: DriftFraming, bottomRateHalf: boolean): string {
  // The rate pairing clause — included only when the project is in the bottom rate half.
  const rate = bottomRateHalf ? ' while it earns one of your lowest hourly rates' : '';

  if (framing === 'checked_out') {
    return (
      `Feeling on ${name} keeps sinking${rate} — the fire is going out. ` +
      `Time for a decision, maybe an ending; it stays in your history.`
    );
  }
  return (
    `Feeling on ${name} has been dropping${rate}, but the fire's still burning — that's strain. ` +
    `Contain it, or raise the rate; it pays, but it's wearing you.`
  );
}

export interface AttentionDriftInput {
  name: string;
  // The latest of (last time log, last income entry, last mood event), falling back to the project's
  // created_at so a never-touched project still has a reference point. The assembler resolves it.
  lastActivityAt: Date;
  asOf: Date;
}

/**
 * Attention drift: an active project untouched for ATTENTION_DRIFT_DAYS. Always offers the
 * guilt-free ending and reassures that history is kept. Returns null while still inside the window.
 */
export function evaluateAttentionDrift(input: AttentionDriftInput): DriftFinding | null {
  const days = (input.asOf.getTime() - input.lastActivityAt.getTime()) / DAY_MS;
  if (days < ATTENTION_DRIFT_DAYS) return null;

  const weeks = Math.max(1, Math.round(days / 7));
  return {
    kind: 'attention_drift',
    sentence:
      `You haven't touched ${input.name} in ${weeks} weeks. ` +
      `End it guilt-free? It stays in your history.`,
  };
}

// --- The weekly budget key (pure) ------------------------------------------

/**
 * The ISO-8601 week `wall` falls in, as "YYYY-Www" (Monday-start; week 1 contains the year's first
 * Thursday). This is the budget's period key. Mirrors routes/closes.ts's week math but computes only
 * the period string; all arithmetic uses UTC getters so it is DST-free.
 */
export function isoWeekPeriod(wall: Date): string {
  const MS_PER_WEEK = 7 * DAY_MS;
  // Pure-date copy at UTC midnight.
  const date = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate()));
  // Monday-start day index: Mon = 0 … Sun = 6.
  const isoDow = (date.getUTCDay() + 6) % 7;

  // The Thursday of this week decides the ISO year.
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() - isoDow + 3);
  const isoYear = thursday.getUTCFullYear();

  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - isoDow);

  // Week 1 is the week containing Jan 4. Count whole weeks from its Monday.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Dow);
  const week = 1 + Math.round((monday.getTime() - week1Monday.getTime()) / MS_PER_WEEK);

  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/**
 * The budget's dedup key. A nudge is emitted only when this key is NOT already in the "shown" set;
 * emitting adds it. Because the key includes the ISO-week period, a second request the same week is
 * suppressed while the next week is a fresh key — the whole "one per project per kind per week,
 * next week again" rule, in one pure function.
 */
export function budgetKey(projectId: number, kind: DriftKind, period: string): string {
  return `${projectId}:${kind}:${period}`;
}

export function shouldEmit(
  shown: ReadonlySet<string>,
  projectId: number,
  kind: DriftKind,
  period: string,
): boolean {
  return !shown.has(budgetKey(projectId, kind, period));
}

// ---------------------------------------------------------------------------
// The DB-facing assembler — the read model behind the /api/signals `nudges` array
// ---------------------------------------------------------------------------

// The JSON contract per nudge: sentence-first, like Signal. `kind` lets the client offer "End it"
// directly on an attention_drift nudge (into the ending ritual); no other UI depends on it.
export interface Nudge {
  project_id: number;
  name: string;
  kind: DriftKind;
  sentence: string;
}

interface ActiveProjectRow {
  id: number;
  name: string;
  created_at: Date;
}

/**
 * Assemble the drift nudges for `userId`, enforcing the weekly budget. Runs ON DEMAND at request
 * time (BUSINESS_LOGIC §7: no daemon). Emitting a nudge appends its budget row to nudge_log; a
 * kind already shown for a project this ISO week is silently skipped. Returns the emitted nudges
 * most-concerning first (feeling drift before attention drift), an empty array being the common
 * quiet-portfolio result.
 *
 * @param asOf reference "now"; every window (streak, 45-day, ISO week) is measured back from here.
 */
export async function buildNudgesForUser(userId: number, asOf: Date = new Date()): Promise<Nudge[]> {
  // 1. Active, non-deleted projects only. Paused is exempt (pausing IS the user's answer — §2.7
  //    open question 2, V1); ended/idea are not active. Scoped by user_id.
  const projects = await db('projects')
    .where('user_id', userId)
    .andWhere('status', 'active')
    .whereNull('deleted_at')
    .select<ActiveProjectRow[]>('id', 'name', 'created_at');
  if (projects.length === 0) return [];

  const projectIds = projects.map((p) => p.id);

  // 2. Mood streams (feeling drift), oldest first — one grouped query, user-scoped.
  const eventRows = await db('mood_events')
    .where('user_id', userId)
    .whereIn('project_id', projectIds)
    .whereNull('deleted_at')
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .select<Array<{ project_id: number; value: Feeling | null; created_at: Date }>>(
      'project_id',
      'value',
      'created_at',
    );
  const streamByProject = new Map<number, MoodEventInput[]>();
  for (const row of eventRows) {
    const stream = streamByProject.get(row.project_id) ?? [];
    stream.push({ value: row.value, at: new Date(row.created_at) });
    streamByProject.set(row.project_id, stream);
  }

  // 3. Last activity per project (attention drift): the latest of last time log, last income entry
  //    and last mood event, falling back to the project's created_at. The project set is already
  //    user-scoped, so the two aggregate queries filter by project id (mirrors routes/closes.ts).
  const lastActivity = new Map<number, Date>();
  const bump = (projectId: number, at: Date) => {
    const current = lastActivity.get(projectId);
    if (!current || at.getTime() > current.getTime()) lastActivity.set(projectId, at);
  };
  for (const p of projects) bump(p.id, new Date(p.created_at));
  for (const row of eventRows) bump(row.project_id, new Date(row.created_at));

  const dateRows = await Promise.all(
    (['time_logs', 'income_entries'] as const).map((tbl) =>
      db(tbl)
        .whereIn('project_id', projectIds)
        .groupBy('project_id')
        .select<Array<{ project_id: number; last_date: string | null }>>(
          'project_id',
          db.raw("DATE_FORMAT(MAX(date), '%Y-%m-%d') as last_date"),
        ),
    ),
  );
  for (const rows of dateRows) {
    for (const row of rows) {
      if (row.last_date) bump(row.project_id, new Date(`${row.last_date}T00:00:00Z`));
    }
  }

  // 4. Effective hourly rates → the portfolio's bottom rate half (needs ≥2 rated projects to be a
  //    meaningful "half"). Reuses the canonical normalization; never re-derives it.
  const metrics = await computeMetricsForUser(userId);
  const rates = projects
    .map((p) => metrics.get(p.id)?.effectiveHourlyRate ?? null)
    .filter((r): r is number => r !== null)
    .sort((a, b) => a - b);
  // Lower-median: for [a,b] it is a (only the cheaper qualifies); for [a,b,c,d] it is b (a,b
  // qualify). rate ≤ median ⇒ bottom half.
  const median = rates.length >= 2 ? rates[Math.floor((rates.length - 1) / 2)]! : null;
  const isBottomRateHalf = (projectId: number): boolean => {
    if (median === null) return false;
    const rate = metrics.get(projectId)?.effectiveHourlyRate ?? null;
    return rate !== null && rate <= median;
  };

  const period = isoWeekPeriod(asOf);

  // 5. Load this week's already-shown budget rows so repeat requests stay silent. Filtered to this
  //    period, so the pre-loaded keys all share it.
  const existing = await db('nudge_log')
    .where('user_id', userId)
    .andWhere('period', period)
    .whereIn('project_id', projectIds)
    .select<Array<{ project_id: number; kind: DriftKind }>>('project_id', 'kind');
  const shown = new Set(existing.map((r) => budgetKey(r.project_id, r.kind, period)));

  // 6. Evaluate both rules per project; emit only unbudgeted findings, recording each in nudge_log.
  const toInsert: Array<{ user_id: number; project_id: number; kind: DriftKind; period: string }> =
    [];
  const nudges: Nudge[] = [];

  for (const p of projects) {
    const findings: DriftFinding[] = [];

    const feeling = evaluateFeelingDrift(analyzeMood(streamByProject.get(p.id) ?? [], asOf), {
      name: p.name,
      isBottomRateHalf: isBottomRateHalf(p.id),
    });
    if (feeling) findings.push(feeling);

    const attention = evaluateAttentionDrift({
      name: p.name,
      lastActivityAt: lastActivity.get(p.id) ?? new Date(p.created_at),
      asOf,
    });
    if (attention) findings.push(attention);

    for (const finding of findings) {
      if (!shouldEmit(shown, p.id, finding.kind, period)) continue;
      shown.add(budgetKey(p.id, finding.kind, period));
      toInsert.push({ user_id: userId, project_id: p.id, kind: finding.kind, period });
      nudges.push({
        project_id: p.id,
        name: p.name,
        kind: finding.kind,
        sentence: finding.sentence,
      });
    }
  }

  // Spend the budget. INSERT IGNORE so a concurrent request that raced us to the same (user,
  // project, kind, week) row cannot 500 — the unique constraint is the real guard.
  if (toInsert.length > 0) {
    await db('nudge_log')
      .insert(toInsert)
      .onConflict(['user_id', 'project_id', 'kind', 'period'])
      .ignore();
  }

  // Most concerning first: feeling drift (a decision on a live project) before attention drift (a
  // dormant one), then by project id for stable ordering.
  const kindOrder: Record<DriftKind, number> = { feeling_drift: 0, attention_drift: 1 };
  nudges.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.project_id - b.project_id);
  return nudges;
}
