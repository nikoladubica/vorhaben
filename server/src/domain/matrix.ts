import { db } from '../db/index.js';
import { computeMetricsForUser } from './metrics.js';
import {
  analyzeMood,
  describe,
  type Confidence,
  type MoodEventInput,
  type Swing,
} from './moodAnalysis.js';
import type { Feeling } from './constants.js';

// ---------------------------------------------------------------------------
// Worth-It Matrix assembler (breaktrough.md §2.6) — the read model behind GET /api/matrix
// ---------------------------------------------------------------------------
//
// The signature quadrant screen crosses the effective hourly rate (X) with the feeling trend (Y),
// dot size by monthly hours. Like domain/signals.ts this is the thin DB-facing adapter between the
// database and the PURE engine in domain/moodAnalysis.ts, computed ON DEMAND at request time
// (BUSINESS_LOGIC §7: no background analysis daemon). For each active, non-deleted project it loads
// the live mood stream, runs analyzeMood, and pairs the result with the canonical effective hourly
// rate + windowed hours from computeMetricsForUser (never re-deriving normalization).
//
// Crucially, unlike GET /api/signals — which DROPS projects with nothing describable — the matrix
// returns EVERY active project. The client decides plottability (rate !== null && confidence !==
// 'none'); the unplottable ones are listed honestly below the chart. So there is no filtering here.

// The exact JSON contract the endpoint returns (snake_case, mirroring the existing API style).
export interface MatrixProject {
  project_id: number;
  name: string;
  // Canonical §2.2 effective hourly rate; null when no hours were logged (an unplottable project).
  effective_hourly_rate: number | null;
  // hoursInWindow normalized to a per-month figure — the trailing window is 3 calendar months, so
  // hoursInWindow / 3. Always >= 0; drives dot size on the client.
  monthly_hours: number;
  // analyzeMood trendScore (roughly −5…+5) — the Y axis. null when confidence is 'none' (the engine
  // does not guess before 3 days of data), which also makes the project unplottable.
  trend_score: number | null;
  confidence: Confidence;
  swing: Swing;
  // The First Signal sentence via describe(), or null when there is nothing describable to say.
  sentence: string | null;
}

export interface MatrixPayload {
  base_currency: string;
  // Portfolio MEDIAN effective_hourly_rate over PLOTTABLE projects only — the X quadrant boundary
  // ("pays well for you"). null when there are no plottable projects.
  median_rate: number | null;
  projects: MatrixProject[];
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

/**
 * Assemble the Worth-It Matrix payload for `userId`.
 *
 * @returns every active, non-deleted project (plottable and not) plus the portfolio median rate.
 *          An empty projects array is a valid result (a fresh account).
 */
export async function buildMatrixForUser(userId: number): Promise<MatrixPayload> {
  const asOf = new Date();

  // 1. Base currency (defaults to EUR if the user row is somehow missing) — same source as metrics.
  const user = await db('users').where('id', userId).first('base_currency');
  const baseCurrency = (user as { base_currency: string } | undefined)?.base_currency ?? 'EUR';

  // 2. Active, non-deleted projects (paused/ended/idea are out of the live matrix, like §2.3).
  //    Scoped by user_id.
  const projects = await db('projects')
    .where('user_id', userId)
    .andWhere('status', 'active')
    .whereNull('deleted_at')
    .select<ProjectRow[]>('id', 'name');
  if (projects.length === 0) {
    return { base_currency: baseCurrency, median_rate: null, projects: [] };
  }

  const projectIds = projects.map((p) => p.id);

  // 3. Every live FEELING event for those projects, oldest first — one grouped query, scoped by
  //    user_id as defence in depth on top of the project set (mirrors signals.ts). Scoped to
  //    kind='feeling' because analyzeMood interprets values as feelings; trend/untouched rows are a
  //    different question and must not enter the matrix's Y axis (ticket 26). Legacy-valued rows are
  //    kind='feeling', so they still contribute exactly as before.
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

  // 4. Canonical windowed metrics — reused for the effective hourly rate + windowed hours pairing.
  //    Never re-derives normalization.
  const metrics = await computeMetricsForUser(userId);

  // 5. Build one row per project. No filtering — the client decides plottability.
  const rows: MatrixProject[] = projects.map((project) => {
    const analysis = analyzeMood(streamByProject.get(project.id) ?? [], asOf);
    const projectMetrics = metrics.get(project.id);
    const rate = projectMetrics?.effectiveHourlyRate ?? null;
    const hoursInWindow = projectMetrics?.hoursInWindow ?? 0;
    const described = describe(analysis, { name: project.name });

    return {
      project_id: project.id,
      name: project.name,
      effective_hourly_rate: rate,
      // Trailing window is 3 calendar months; normalize windowed hours to a per-month figure.
      monthly_hours: hoursInWindow / 3,
      trend_score: analysis.confidence === 'none' ? null : analysis.trendScore,
      confidence: analysis.confidence,
      swing: analysis.swing,
      sentence: described?.sentence ?? null,
    };
  });

  // 6. Portfolio median effective hourly rate over PLOTTABLE projects only (the X boundary).
  const plottableRates = rows
    .filter((r) => r.effective_hourly_rate !== null && r.confidence !== 'none')
    .map((r) => r.effective_hourly_rate as number)
    .sort((a, b) => a - b);
  const medianRate = medianOf(plottableRates);

  // 7. Order by name ascending for stable rendering.
  rows.sort((a, b) => a.name.localeCompare(b.name));

  return { base_currency: baseCurrency, median_rate: medianRate, projects: rows };
}

// Median of an already-ascending list; null when empty (fewer than 1 plottable project).
function medianOf(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}
