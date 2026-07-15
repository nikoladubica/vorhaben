import { db } from '../db/index.js';
import { computeMetricsForUser } from './metrics.js';
import {
  analyzeMood,
  analyzeTrendDirection,
  describe,
  describeDivergence,
  type Confidence,
  type Direction,
  type Fire,
  type MoodAnalysis,
  type MoodEventInput,
  type Swing,
  type TrendEventInput,
} from './moodAnalysis.js';
import type { Feeling, Trend } from './constants.js';

// ---------------------------------------------------------------------------
// Signals assembler (breaktrough.md §2.3–§2.4) — the read model behind GET /api/signals
// ---------------------------------------------------------------------------
//
// This is the thin DB-facing adapter between the database and the PURE engine in
// domain/moodAnalysis.ts — the same split as domain/dashboard.ts ↔ domain/suggestions.ts. It runs
// ON DEMAND at request time (BUSINESS_LOGIC §7: no background analysis daemon, no cached scores
// table). For each active, non-deleted project it loads the live mood stream, runs analyzeMood,
// pairs the result with the canonical effective hourly rate from computeMetricsForUser (never
// re-deriving normalization), and renders the one-line First Signal via describe(). Projects with
// nothing to say (confidence 'none', or no finding) are omitted; the rest are ordered
// most-concerning first.

// The exact JSON contract the endpoint returns. trend_score travels for the future Worth-It Matrix
// (ticket 05); this ticket's UI renders `sentence` + the confidence label only. fire surfaces as a
// word, never a score.
export interface Signal {
  project_id: number;
  name: string;
  confidence: Exclude<Confidence, 'none'>;
  direction: Direction | null;
  energy_direction: Direction | null;
  fire: Fire | null;
  swing: Swing;
  streak: number;
  trend_score: number;
  days: number; // data span in whole days — powers the "N DAYS OF DATA" eyebrow on the client
  finding: string;
  sentence: string;
}

interface ProjectRow {
  id: number;
  name: string;
}

interface MoodEventRow {
  project_id: number;
  value: Feeling | null;
  created_at: Date;
}

interface TrendEventRow {
  project_id: number;
  value: Trend | null;
  created_at: Date;
}

/**
 * Assemble the ordered signals for `userId`.
 *
 * @returns the describable signals, most-concerning first (an empty array is a valid, common
 *          result — a quiet portfolio says nothing).
 */
export async function buildSignalsForUser(userId: number): Promise<Signal[]> {
  const asOf = new Date();

  // 1. Active, non-deleted projects (paused/ended/idea are out of the live signal per §2.3 "each
  //    active project"). Scoped by user_id.
  const projects = await db('projects')
    .where('user_id', userId)
    .andWhere('status', 'active')
    .whereNull('deleted_at')
    .select<ProjectRow[]>('id', 'name');
  if (projects.length === 0) return [];

  const projectIds = projects.map((p) => p.id);

  // 2. Every live FEELING event for those projects, oldest first — one grouped query, scoped by
  //    user_id as defence in depth on top of the project set. Scoped to kind='feeling' because
  //    analyzeMood interprets values on the valence/energy maps; trend/untouched rows would not map
  //    (ticket 26). Legacy-valued rows are kind='feeling' too, so they still flow through and score.
  const eventRows = await db('mood_events')
    .where({ user_id: userId, kind: 'feeling' })
    .whereIn('project_id', projectIds)
    .whereNull('deleted_at')
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .select<MoodEventRow[]>('project_id', 'value', 'created_at');

  const streamByProject = new Map<number, MoodEventInput[]>();
  for (const row of eventRows) {
    const stream = streamByProject.get(row.project_id) ?? [];
    stream.push({ value: row.value, at: new Date(row.created_at) });
    streamByProject.set(row.project_id, stream);
  }

  // 2b. The self-reported TREND stream, same shape — feeds the trend/feeling divergence heuristic.
  const trendRows = await db('mood_events')
    .where({ user_id: userId, kind: 'trend' })
    .whereIn('project_id', projectIds)
    .whereNull('deleted_at')
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .select<TrendEventRow[]>('project_id', 'value', 'created_at');

  const trendByProject = new Map<number, TrendEventInput[]>();
  for (const row of trendRows) {
    const stream = trendByProject.get(row.project_id) ?? [];
    stream.push({ value: row.value, at: new Date(row.created_at) });
    trendByProject.set(row.project_id, stream);
  }

  // 3. Canonical windowed metrics — reused once for the effective hourly rate pairing (§2.3 "read
  //    next to hourly rate"). Never re-derives normalization.
  const metrics = await computeMetricsForUser(userId);

  // Lowest hourly rate across the rated active projects (needs ≥2 to be a meaningful "lowest").
  const rates = projects
    .map((p) => metrics.get(p.id)?.effectiveHourlyRate ?? null)
    .filter((r): r is number => r !== null);
  const minRate = rates.length >= 2 ? Math.min(...rates) : null;

  // 4. First pass: analyze every project so cross-project context (isOnlyDown) can be computed.
  const analyses = projects.map((p) => ({
    project: p,
    analysis: analyzeMood(streamByProject.get(p.id) ?? [], asOf),
    rate: metrics.get(p.id)?.effectiveHourlyRate ?? null,
  }));

  const downCount = analyses.filter(
    (a) => a.analysis.confidence !== 'none' && a.analysis.direction === 'down',
  ).length;

  // Build the Signal envelope for a project from its feeling analysis, with the finding/sentence
  // supplied by whichever heuristic fired (the First Signal or the divergence heuristic).
  const toSignal = (
    project: ProjectRow,
    analysis: MoodAnalysis,
    finding: string,
    sentence: string,
  ): Signal => ({
    project_id: project.id,
    name: project.name,
    confidence: analysis.confidence as Exclude<Confidence, 'none'>,
    direction: analysis.direction,
    energy_direction: analysis.energyDirection,
    fire: analysis.fire,
    swing: analysis.swing,
    streak: analysis.streak,
    trend_score: analysis.trendScore,
    days: Math.round(analysis.spanDays),
    finding,
    sentence,
  });

  // 5. Second pass: render each describable signal, carrying the pairing context. A project may
  //    surface both its First Signal AND a trend/feeling divergence observation (ticket 26) — they
  //    answer different questions, so both are listed, ordered by their own concern.
  const scored: { signal: Signal; concern: number }[] = [];
  for (const { project, analysis, rate } of analyses) {
    if (analysis.confidence === 'none') continue;
    const isLowestRate = minRate !== null && rate !== null && rate === minRate;
    const isOnlyDown = downCount === 1 && analysis.direction === 'down';
    const described = describe(analysis, { name: project.name, isLowestRate, isOnlyDown });
    if (described !== null) {
      scored.push({
        concern: described.concern,
        signal: toSignal(project, analysis, described.finding, described.sentence),
      });
    }

    // Divergence between the two self-reported streams (trend vs feeling direction).
    const trendDirection = analyzeTrendDirection(trendByProject.get(project.id) ?? [], asOf);
    const divergence = describeDivergence(analysis.direction, trendDirection, {
      name: project.name,
    });
    if (divergence !== null) {
      scored.push({
        concern: divergence.concern,
        signal: toSignal(project, analysis, divergence.finding, divergence.sentence),
      });
    }
  }

  // 6. Most concerning first; tie-break by the more negative trend, then project id for stability.
  scored.sort(
    (a, b) =>
      b.concern - a.concern ||
      a.signal.trend_score - b.signal.trend_score ||
      a.signal.project_id - b.signal.project_id,
  );

  return scored.map((s) => s.signal);
}
