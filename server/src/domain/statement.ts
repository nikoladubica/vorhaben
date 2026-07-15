import { db } from '../db/index.js';
import { computeMetricsForUser } from './metrics.js';
import {
  analyzeMood,
  describe,
  valenceOf,
  type Confidence,
  type Direction,
  type MoodAnalysis,
  type MoodEventInput,
  type Swing,
} from './moodAnalysis.js';
import { evaluateFeelingDrift, type DriftFinding } from './drift.js';
import type { ProjectMetrics } from './normalization.js';
import type { Feeling } from './constants.js';

// ---------------------------------------------------------------------------
// The Quarterly Statement (breaktrough.md §2.8, ticket 07) — the capstone read model
// ---------------------------------------------------------------------------
//
// Everything the habit slice produces, typeset the way a private bank writes your quarter. This
// module is split the same way moodAnalysis.ts ↔ signals.ts / drift.ts split:
//
//   - PURE assembly (assembleStatement) — plain data in, plain data out, no Knex, no Express, no
//     clock beyond the `generatedAt` the caller passes. Given a seeded quarter the model is
//     DETERMINISTIC, so it is exercised by statement.test.ts with fixtures alone. It reuses the
//     PURE engines (analyzeMood / describe / evaluateFeelingDrift) and the ALREADY-COMPUTED
//     normalization metrics — it never re-derives normalization or the mood mapping.
//   - the DB-facing loaders (buildStatementForUser / listStatementPeriods) — load the quarter's
//     projects, quarter-windowed metrics, mood streams and weekly closes, then hand fixtures to
//     the pure core.
//
// Statements are COMPUTED, NOT STORED (ticket step 2): history is already the database; a
// statement is a view of it, so a past quarter stays consistent with any later data correction —
// the honest behavior for self-reported data. Nothing is persisted or cached; no PDF is generated
// server-side (the client's print stylesheet is the export). No LLM anywhere; identical
// self-hosted and hosted (a statement is a core feature, never gated). All money is server-side
// converted to the user's base currency through metrics.ts; the narrative is TEMPLATE PROSE from
// heuristics, in the engine's register (observations, warm, Swiss).

const DAY_MS = 24 * 60 * 60 * 1000;

// Concentration threshold (BUSINESS_LOGIC §4.2 rule 4): one project above this share of the
// quarter's income is a concentration finding — the lowest-priority of the three recommendations.
const CONCENTRATION_SHARE = 0.6;

// A trajectory "turn" worth quoting near: the largest consecutive valence jump in the quarter must
// be at least this big (on the −2…+2 axis) to count as a clear turn, so a quote sits on a real
// move, not noise. |Δ| ≥ 2 is a full step across the mid-line (e.g. opportunistic → sad).
const QUOTE_MIN_TURN = 2;

// ---------------------------------------------------------------------------
// Period parsing ("YYYY-Qn") and quarter date bounds
// ---------------------------------------------------------------------------

const PERIOD_RE = /^(\d{4})-Q([1-4])$/;

export interface QuarterRange {
  year: number;
  quarter: number; // 1–4
  period: string; // "2026-Q2"
  label: string; // "Q2 2026"
  from: string; // 'YYYY-MM-DD' first day of the quarter
  to: string; // 'YYYY-MM-DD' last day of the quarter
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// Last calendar day of a 1-based month, UTC-anchored (day 0 of the next month rolls back one day).
function lastDayOfMonth(year: number, month1: number): string {
  const d = new Date(Date.UTC(year, month1, 0));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Build the {@link QuarterRange} for a year + quarter (1–4). Pure; no clock. */
export function quarterRange(year: number, quarter: number): QuarterRange {
  const startMonth = (quarter - 1) * 3 + 1; // 1,4,7,10
  const endMonth = quarter * 3; // 3,6,9,12
  return {
    year,
    quarter,
    period: `${year}-Q${quarter}`,
    label: `Q${quarter} ${year}`,
    from: `${year}-${pad2(startMonth)}-01`,
    to: lastDayOfMonth(year, endMonth),
  };
}

/** Parse a "YYYY-Qn" period string, or null when malformed. Pure. */
export function parsePeriod(period: string): QuarterRange | null {
  const m = PERIOD_RE.exec(period);
  if (!m) return null;
  return quarterRange(Number(m[1]), Number(m[2]));
}

// The quarter immediately before a range (Q1 wraps to the previous year's Q4).
function previousQuarter(range: QuarterRange): QuarterRange {
  return range.quarter === 1
    ? quarterRange(range.year - 1, 4)
    : quarterRange(range.year, range.quarter - 1);
}

// The quarter a 'YYYY-MM-DD' date falls in.
function quarterOf(dateYmd: string): QuarterRange {
  const year = Number(dateYmd.slice(0, 4));
  const month = Number(dateYmd.slice(5, 7)); // 1–12
  return quarterRange(year, Math.floor((month - 1) / 3) + 1);
}

// The Monday (UTC 'YYYY-MM-DD') an ISO-8601 week label ("YYYY-Www") starts on — the inverse of
// drift.ts's isoWeekPeriod, so a weekly_close can be attributed to the quarter its week belongs to.
export function isoWeekStart(weekLabel: string): string | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekLabel);
  if (!m) return null;
  const isoYear = Number(m[1]);
  const week = Number(m[2]);
  // Week 1 is the week containing Jan 4; count whole weeks forward from its Monday.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7; // Mon = 0 … Sun = 6
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Dow);
  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return `${monday.getUTCFullYear()}-${pad2(monday.getUTCMonth() + 1)}-${pad2(monday.getUTCDate())}`;
}

// ---------------------------------------------------------------------------
// Pure assembly — inputs (materialized fixtures) and output (the JSON contract)
// ---------------------------------------------------------------------------

// One live mood event in (or up to the end of) the quarter, oldest first. `note` / `transcript`
// are the optional verbatim "why?" (§2.2); either may be present, both may be null.
export interface StatementMoodEvent {
  at: Date;
  value: Feeling | null;
  note: string | null;
  transcript: string | null;
}

// Everything the pure core needs about one project active in the quarter.
export interface StatementProjectInput {
  id: number;
  name: string;
  type: string;
  status: string;
  startDate: string; // 'YYYY-MM-DD'
  endDate: string | null; // 'YYYY-MM-DD' or null when ongoing
  endingNote: string | null;
  // Quarter-windowed metrics (metrics.ts with { from, to } = the quarter). totalRevenue is all-time.
  metrics: ProjectMetrics;
  // All-time logged hours (for an ended project's honored lifetime totals).
  lifetimeHours: number;
  // Every live mood event up to the quarter end, oldest first (used for the quarter-end analysis);
  // events before the quarter feed the rolling-window verdict, in-quarter ones the trajectory/quotes.
  moodEvents: StatementMoodEvent[];
}

export interface StatementInput {
  range: QuarterRange;
  baseCurrency: string;
  userEmail: string;
  generatedAt: Date;
  projects: StatementProjectInput[];
  weeksClosed: number;
  // Sum of the previous quarter's monthly-equivalent net across the portfolio; null when unknown.
  prevMonthlyNet: number | null;
}

// --- Output shapes (snake_case, mirroring the existing API style) ----------

export interface TrajectoryPoint {
  at: string; // ISO timestamp
  value: Feeling | null;
  valence: number | null; // −2…+2; null for a cleared feeling (a gap in the line)
}

export interface StatementVerdict {
  finding: string;
  sentence: string;
  direction: Direction | null;
  confidence: Exclude<Confidence, 'none'>;
  swing: Swing;
}

export interface StatementPortfolioRow {
  project_id: number;
  name: string;
  type: string;
  status: string;
  monthly_revenue: number | null;
  monthly_expenses: number | null;
  monthly_net: number | null;
  effective_hourly_rate: number | null;
  hours: number; // hours logged in the quarter window
  total_revenue: number | null; // all-time, for context
  trajectory: TrajectoryPoint[];
  verdict: StatementVerdict | null;
  harsh_swing: boolean;
}

export interface StatementLeader {
  project_id: number;
  name: string;
  value: number;
}

export interface StatementAggregates {
  total_monthly_revenue: number | null;
  total_monthly_net: number | null;
  prev_monthly_net: number | null;
  trend_direction: Direction | null;
  best_by_rate: StatementLeader | null;
  best_by_revenue: StatementLeader | null;
  heaviest: StatementLeader | null;
}

export interface EndedProject {
  project_id: number;
  name: string;
  start_date: string;
  end_date: string;
  lifespan_days: number;
  lifetime_revenue: number | null;
  lifetime_hours: number;
  ending_note: string | null;
}

export interface StatementEvents {
  ended: EndedProject[];
  harsh_swings: Array<{ project_id: number; name: string }>;
  weeks_closed: number;
}

export interface StatementQuote {
  project_id: number;
  project_name: string;
  date: string; // 'YYYY-MM-DD'
  text: string; // verbatim, never truncated
}

export type RecommendationKind = 'drift' | 'harsh_swing' | 'concentration';

export interface StatementRecommendation {
  kind: RecommendationKind;
  project_id: number;
  sentence: string;
}

export interface StatementHead {
  period: string;
  label: string;
  year: number;
  quarter: number;
  from: string;
  to: string;
  generated_at: string;
  base_currency: string;
  user_email: string;
}

export interface Statement {
  head: StatementHead;
  portfolio: StatementPortfolioRow[];
  aggregates: StatementAggregates;
  events: StatementEvents;
  quotes: StatementQuote[];
  recommendation: StatementRecommendation | null;
}

// --- Rounding (done once at this edge; the engines keep full precision) -----

function roundMoney(value: number | null): number | null {
  if (value === null) return null;
  return Math.round(value * 100) / 100;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function ymd(at: Date): string {
  return at.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// The pure core
// ---------------------------------------------------------------------------

/**
 * Assemble the full quarter model from materialized fixtures. Pure and deterministic — no DB, no
 * clock beyond `input.generatedAt`. The DB-facing buildStatementForUser feeds it.
 */
export function assembleStatement(input: StatementInput): Statement {
  const { range, projects } = input;
  const quarterEnd = new Date(`${range.to}T23:59:59Z`);
  const quarterStartMs = new Date(`${range.from}T00:00:00Z`).getTime();

  // Analyze each project ONCE, as of the quarter end (the rolling windows read back from there).
  const analyses = new Map<number, MoodAnalysis>();
  for (const p of projects) {
    analyses.set(
      p.id,
      analyzeMood(
        p.moodEvents.map((e): MoodEventInput => ({ value: e.value, at: e.at })),
        quarterEnd,
      ),
    );
  }

  // --- Portfolio rows -------------------------------------------------------
  const portfolio: StatementPortfolioRow[] = projects.map((p) => {
    const analysis = analyses.get(p.id)!;
    const inQuarter = p.moodEvents.filter((e) => e.at.getTime() >= quarterStartMs);
    const trajectory: TrajectoryPoint[] = inQuarter.map((e) => ({
      at: e.at.toISOString(),
      value: e.value,
      valence: valenceOf(e.value),
    }));

    // Verdict = the First Signal sentence at quarter end (null below the early confidence bar).
    const described = analysis.confidence === 'none' ? null : describe(analysis, { name: p.name });
    const verdict: StatementVerdict | null =
      described === null || analysis.confidence === 'none'
        ? null
        : {
            finding: described.finding,
            sentence: described.sentence,
            direction: analysis.direction,
            confidence: analysis.confidence,
            swing: analysis.swing,
          };

    return {
      project_id: p.id,
      name: p.name,
      type: p.type,
      status: p.status,
      monthly_revenue: roundMoney(p.metrics.monthlyRevenue),
      monthly_expenses: roundMoney(p.metrics.monthlyExpenses),
      monthly_net: roundMoney(p.metrics.monthlyNet),
      effective_hourly_rate: roundMoney(p.metrics.effectiveHourlyRate),
      hours: round1(p.metrics.hoursInWindow),
      total_revenue: roundMoney(p.metrics.totalRevenue),
      trajectory,
      verdict,
      harsh_swing: analysis.swing === 'harsh',
    };
  });
  // Stable order: name ascending (the client may re-sort).
  portfolio.sort((a, b) => a.name.localeCompare(b.name));

  // --- Aggregates -----------------------------------------------------------
  const aggregates = buildAggregates(portfolio, input.prevMonthlyNet);

  // --- Events ---------------------------------------------------------------
  const ended: EndedProject[] = projects
    .filter((p) => p.endDate !== null && p.endDate >= range.from && p.endDate <= range.to)
    .map((p) => ({
      project_id: p.id,
      name: p.name,
      start_date: p.startDate,
      end_date: p.endDate as string,
      lifespan_days: daysBetween(p.startDate, p.endDate as string),
      lifetime_revenue: roundMoney(p.metrics.totalRevenue),
      lifetime_hours: round1(p.lifetimeHours),
      ending_note: p.endingNote,
    }))
    .sort((a, b) => a.end_date.localeCompare(b.end_date) || a.name.localeCompare(b.name));

  const harshSwings = portfolio
    .filter((row) => row.harsh_swing)
    .map((row) => ({ project_id: row.project_id, name: row.name }));

  const events: StatementEvents = {
    ended,
    harsh_swings: harshSwings,
    weeks_closed: input.weeksClosed,
  };

  // --- Quotes ---------------------------------------------------------------
  const quotes = buildQuotes(projects, quarterStartMs);

  // --- The one recommendation ----------------------------------------------
  const recommendation = pickRecommendation(projects, analyses, portfolio);

  return {
    head: {
      period: range.period,
      label: range.label,
      year: range.year,
      quarter: range.quarter,
      from: range.from,
      to: range.to,
      generated_at: input.generatedAt.toISOString(),
      base_currency: input.baseCurrency,
      user_email: input.userEmail,
    },
    portfolio,
    aggregates,
    events,
    quotes,
    recommendation,
  };
}

function buildAggregates(
  portfolio: StatementPortfolioRow[],
  prevMonthlyNet: number | null,
): StatementAggregates {
  const sum = (pick: (r: StatementPortfolioRow) => number | null): number | null => {
    const vals = portfolio.map(pick).filter((v): v is number => v !== null);
    return vals.length === 0 ? null : roundMoney(vals.reduce((a, b) => a + b, 0));
  };
  const totalMonthlyRevenue = sum((r) => r.monthly_revenue);
  const totalMonthlyNet = sum((r) => r.monthly_net);

  // Trend direction: this quarter's net vs the previous quarter's, with a small dead-band so a
  // trivial move reads flat. null when there is no prior figure to compare against.
  let trend: Direction | null = null;
  if (totalMonthlyNet !== null && prevMonthlyNet !== null) {
    const delta = totalMonthlyNet - prevMonthlyNet;
    const band = Math.max(1, Math.abs(prevMonthlyNet) * 0.02);
    trend = delta > band ? 'up' : delta < -band ? 'down' : 'flat';
  }

  return {
    total_monthly_revenue: totalMonthlyRevenue,
    total_monthly_net: totalMonthlyNet,
    prev_monthly_net: roundMoney(prevMonthlyNet),
    trend_direction: trend,
    best_by_rate: leaderBy(portfolio, (r) => r.effective_hourly_rate),
    best_by_revenue: leaderBy(portfolio, (r) => r.monthly_net),
    heaviest: leaderByHours(portfolio),
  };
}

// The single highest project by a nullable money metric; null when none qualifies. `portfolio` is
// already sorted by name, so a strict-greater comparison keeps the name-ascending winner on ties.
function leaderBy(
  portfolio: StatementPortfolioRow[],
  pick: (r: StatementPortfolioRow) => number | null,
): StatementLeader | null {
  let best: StatementLeader | null = null;
  for (const r of portfolio) {
    const v = pick(r);
    if (v === null) continue;
    if (best === null || v > best.value) {
      best = { project_id: r.project_id, name: r.name, value: v };
    }
  }
  return best;
}

// Heaviest project = most hours logged in the quarter; ignore zero-hour projects. Ties break by name.
function leaderByHours(portfolio: StatementPortfolioRow[]): StatementLeader | null {
  let best: StatementLeader | null = null;
  for (const r of portfolio) {
    if (r.hours <= 0) continue;
    if (best === null || r.hours > best.value) {
      best = { project_id: r.project_id, name: r.name, value: r.hours };
    }
  }
  return best;
}

// The verbatim "why?" behind an event: prefer the typed note, fall back to the voice transcript.
function textOf(e: StatementMoodEvent): string | null {
  if (e.note !== null && e.note.trim() !== '') return e.note;
  if (e.transcript !== null && e.transcript.trim() !== '') return e.transcript;
  return null;
}

/**
 * One quote per project whose in-quarter trajectory has a CLEAR TURN (largest |Δvalence| between
 * consecutive valued events ≥ QUOTE_MIN_TURN). The quoted text is the note/transcript attached
 * NEAREST that turn, verbatim and dated. A quarter with no annotated turns yields no quotes (no
 * filler). Ordered by the size of the turn, then date.
 */
function buildQuotes(projects: StatementProjectInput[], quarterStartMs: number): StatementQuote[] {
  const quotes: Array<{ quote: StatementQuote; turn: number }> = [];

  for (const p of projects) {
    const inQuarter = p.moodEvents.filter((e) => e.at.getTime() >= quarterStartMs);
    const valued = inQuarter.filter((e) => e.value !== null);
    if (valued.length < 2) continue;

    // Largest consecutive valence jump and the event it lands on (the "turn").
    let maxTurn = 0;
    let turnAt: Date | null = null;
    for (let i = 1; i < valued.length; i++) {
      const prev = valenceOf(valued[i - 1]!.value)!;
      const curr = valenceOf(valued[i]!.value)!;
      const delta = Math.abs(curr - prev);
      if (delta > maxTurn) {
        maxTurn = delta;
        turnAt = valued[i]!.at;
      }
    }
    if (turnAt === null || maxTurn < QUOTE_MIN_TURN) continue;

    // The annotated in-quarter event nearest the turn (verbatim). None ⇒ this project has no quote.
    let nearest: StatementMoodEvent | null = null;
    let nearestGap = Infinity;
    for (const e of inQuarter) {
      if (textOf(e) === null) continue;
      const gap = Math.abs(e.at.getTime() - turnAt.getTime());
      if (gap < nearestGap) {
        nearestGap = gap;
        nearest = e;
      }
    }
    if (nearest === null) continue;

    quotes.push({
      turn: maxTurn,
      quote: {
        project_id: p.id,
        project_name: p.name,
        date: ymd(nearest.at),
        text: textOf(nearest) as string,
      },
    });
  }

  quotes.sort((a, b) => b.turn - a.turn || a.quote.date.localeCompare(b.quote.date));
  return quotes.map((q) => q.quote);
}

/**
 * Exactly one recommendation, ranked by severity: drift > harsh swing > concentration. Returns
 * null when nothing fires (a sparse quarter gets no filler suggestion, mirroring the quotes rule).
 */
function pickRecommendation(
  projects: StatementProjectInput[],
  analyses: Map<number, MoodAnalysis>,
  portfolio: StatementPortfolioRow[],
): StatementRecommendation | null {
  // Bottom rate half of the portfolio (needs ≥2 rated projects) — unlocks the drift rate clause.
  const rates = portfolio
    .map((r) => r.effective_hourly_rate)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const median = rates.length >= 2 ? rates[Math.floor((rates.length - 1) / 2)]! : null;
  const isBottomRateHalf = (projectId: number): boolean => {
    if (median === null) return false;
    const rate = portfolio.find((r) => r.project_id === projectId)?.effective_hourly_rate ?? null;
    return rate !== null && rate <= median;
  };

  // 1. Feeling drift on a still-active project — the most severe finding. Reuse the engine's
  //    sentence verbatim (checked-out framing outranks strain; deterministic by project id).
  const driftHits: Array<{ projectId: number; finding: DriftFinding }> = [];
  for (const p of projects) {
    if (p.status !== 'active') continue;
    const finding = evaluateFeelingDrift(analyses.get(p.id)!, {
      name: p.name,
      isBottomRateHalf: isBottomRateHalf(p.id),
    });
    if (finding) driftHits.push({ projectId: p.id, finding });
  }
  if (driftHits.length > 0) {
    driftHits.sort((a, b) => {
      const rank = (f: DriftFinding) => (f.framing === 'checked_out' ? 0 : 1);
      return rank(a.finding) - rank(b.finding) || a.projectId - b.projectId;
    });
    const top = driftHits[0]!;
    return { kind: 'drift', project_id: top.projectId, sentence: top.finding.sentence };
  }

  // 2. Harsh swing — pick the harsh-swinging project (deterministic by name via portfolio order).
  const harsh = portfolio.find((r) => r.harsh_swing);
  if (harsh) {
    return {
      kind: 'harsh_swing',
      project_id: harsh.project_id,
      sentence:
        `${harsh.name} swung hard this quarter — loved one day, heavy the next. ` +
        `Before you commit more to it next quarter, note what keeps flipping it.`,
    };
  }

  // 3. Concentration — one project above CONCENTRATION_SHARE of the quarter's income.
  const revenues = portfolio
    .map((r) => ({ row: r, rev: r.monthly_revenue }))
    .filter((x): x is { row: StatementPortfolioRow; rev: number } => x.rev !== null && x.rev > 0);
  const total = revenues.reduce((a, x) => a + x.rev, 0);
  if (total > 0) {
    let top = revenues[0];
    for (const x of revenues) if (top === undefined || x.rev > top.rev) top = x;
    if (top !== undefined && top.rev / total > CONCENTRATION_SHARE) {
      const pct = Math.round((top.rev / total) * 100);
      return {
        kind: 'concentration',
        project_id: top.row.project_id,
        sentence:
          `${top.row.name} made up ${pct}% of your income this quarter. ` +
          `Consider building a second source next quarter to lower the concentration.`,
      };
    }
  }

  return null;
}

function daysBetween(fromYmd: string, toYmd: string): number {
  const a = new Date(`${fromYmd}T00:00:00Z`).getTime();
  const b = new Date(`${toYmd}T00:00:00Z`).getTime();
  return Math.max(0, Math.round((b - a) / DAY_MS));
}

// ---------------------------------------------------------------------------
// DB-facing loaders
// ---------------------------------------------------------------------------

interface ProjectMetaRow {
  id: number;
  name: string;
  type: string;
  status: string;
  start_date: string;
  end_date: string | null;
  ending_note: string | null;
}

interface MoodEventRow {
  project_id: number;
  value: Feeling | null;
  note: string | null;
  source_transcript: string | null;
  created_at: Date;
}

// Sum the monthly-equivalent net across a metrics map — the portfolio total for a window.
function sumMonthlyNet(metrics: Map<number, ProjectMetrics>, projectIds: number[]): number | null {
  let total: number | null = null;
  for (const id of projectIds) {
    const net = metrics.get(id)?.monthlyNet;
    if (net === null || net === undefined) continue;
    total = (total ?? 0) + net;
  }
  return total;
}

/**
 * Build the full Quarterly Statement for `userId` + `period` ("YYYY-Qn"), computed on demand.
 * Returns null when the period string is malformed (the route answers 404). Every query is
 * user-scoped and soft-delete aware; all money is converted to the user's base currency.
 */
export async function buildStatementForUser(
  userId: number,
  period: string,
  generatedAt: Date = new Date(),
): Promise<Statement | null> {
  const range = parsePeriod(period);
  if (range === null) return null;

  // 1. Base currency + user email for the statement head.
  const user = await db('users')
    .where('id', userId)
    .first<{ base_currency: string; email: string } | undefined>('base_currency', 'email');
  const baseCurrency = user?.base_currency ?? 'EUR';
  const userEmail = user?.email ?? '';

  // 2. Non-deleted projects whose lifespan overlaps the quarter (started on/before the quarter end
  //    and not ended before it began). Scoped by user_id.
  const projectMeta = await db('projects')
    .where('user_id', userId)
    .whereNull('deleted_at')
    .andWhere('start_date', '<=', range.to)
    .andWhere((qb) => qb.whereNull('end_date').orWhere('end_date', '>=', range.from))
    .select<ProjectMetaRow[]>(
      'id',
      'name',
      'type',
      'status',
      db.raw("DATE_FORMAT(start_date, '%Y-%m-%d') as start_date"),
      db.raw("DATE_FORMAT(end_date, '%Y-%m-%d') as end_date"),
      'ending_note',
    );

  // 3. Quarter-windowed metrics (never re-derives normalization) + the previous quarter's, for the
  //    portfolio trend. computeMetricsForUser returns every non-deleted project; we index by id.
  const [metrics, prevMetrics] = await Promise.all([
    computeMetricsForUser(userId, { from: range.from, to: range.to }),
    (() => {
      const prev = previousQuarter(range);
      return computeMetricsForUser(userId, { from: prev.from, to: prev.to });
    })(),
  ]);

  const projectIds = projectMeta.map((p) => p.id);
  const prevMonthlyNet = sumMonthlyNet(prevMetrics, [...prevMetrics.keys()]);

  // 4. Every live FEELING event up to the quarter end for the overlapping projects, oldest first —
  //    one grouped query, user-scoped. Events before the quarter feed the rolling-window verdict.
  //    Scoped to kind='feeling': the statement's trajectory, verdict and quotes all interpret values
  //    as feelings; trend/untouched rows are a different question (ticket 26). Legacy-valued rows are
  //    kind='feeling', so past events read exactly as before.
  const eventRows =
    projectIds.length === 0
      ? []
      : await db('mood_events')
          .where({ user_id: userId, kind: 'feeling' })
          .whereIn('project_id', projectIds)
          .whereNull('deleted_at')
          .andWhereRaw('DATE(created_at) <= ?', [range.to])
          .orderBy('created_at', 'asc')
          .orderBy('id', 'asc')
          .select<MoodEventRow[]>('project_id', 'value', 'note', 'source_transcript', 'created_at');
  const eventsByProject = new Map<number, StatementMoodEvent[]>();
  for (const row of eventRows) {
    const list = eventsByProject.get(row.project_id) ?? [];
    list.push({
      at: new Date(row.created_at),
      value: row.value,
      note: row.note,
      transcript: row.source_transcript,
    });
    eventsByProject.set(row.project_id, list);
  }

  // 5. All-time logged hours per project (an ended project's honored lifetime total) — one grouped
  //    query over the overlapping set. Ownership flows through the already user-scoped project set.
  const hourRows =
    projectIds.length === 0
      ? []
      : await db('time_logs')
          .whereIn('project_id', projectIds)
          .groupBy('project_id')
          .select<Array<{ project_id: number; hours: string }>>(
            'project_id',
            db.raw('SUM(hours) as hours'),
          );
  const lifetimeHours = new Map<number, number>();
  for (const row of hourRows) lifetimeHours.set(row.project_id, Number(row.hours));

  // 6. Weeks closed IN the quarter: live weekly_closes whose ISO-week Monday falls in [from, to].
  const closeRows = await db('weekly_closes')
    .where('user_id', userId)
    .whereNull('deleted_at')
    .select<Array<{ period: string }>>('period');
  let weeksClosed = 0;
  for (const row of closeRows) {
    const monday = isoWeekStart(row.period);
    if (monday !== null && monday >= range.from && monday <= range.to) weeksClosed++;
  }

  // 7. Materialize the per-project inputs and hand them to the pure core. A default (all-null)
  //    metrics record covers a project with no entries so it still lists.
  const projects: StatementProjectInput[] = projectMeta.map((meta) => ({
    id: meta.id,
    name: meta.name,
    type: meta.type,
    status: meta.status,
    startDate: meta.start_date,
    endDate: meta.end_date,
    endingNote: meta.ending_note,
    metrics: metrics.get(meta.id) ?? emptyMetrics(range.from, range.to),
    lifetimeHours: lifetimeHours.get(meta.id) ?? 0,
    moodEvents: eventsByProject.get(meta.id) ?? [],
  }));

  return assembleStatement({
    range,
    baseCurrency,
    userEmail,
    generatedAt,
    projects,
    weeksClosed,
    prevMonthlyNet,
  });
}

// A zero/null metrics record for a project the loader found but computeMetricsForUser did not key
// (defensive; in practice every non-deleted project is present).
function emptyMetrics(from: string, to: string): ProjectMetrics {
  return {
    totalRevenue: null,
    totalExpenses: null,
    monthlyRevenue: null,
    monthlyExpenses: null,
    monthlyNet: null,
    effectiveHourlyRate: null,
    hoursInWindow: 0,
    entryCount: 0,
    missingRates: false,
    window: { from, to, months: 0 },
  };
}

// ---------------------------------------------------------------------------
// Available periods — for GET /api/statements
// ---------------------------------------------------------------------------

export interface StatementPeriod {
  period: string;
  label: string;
  year: number;
  quarter: number;
  from: string;
  to: string;
  finished: boolean; // the quarter has fully elapsed (its end is before today)
}

/**
 * The quarters with enough data to render a statement, newest first. A quarter qualifies once it
 * has ANY income entry or mood event within it. `finished` marks quarters whose end is before
 * `asOf` — the client shows the Dashboard ready-line for the newest finished one only.
 */
export async function listStatementPeriods(
  userId: number,
  asOf: Date = new Date(),
): Promise<StatementPeriod[]> {
  const today = ymd(asOf);

  // The earliest and latest dated activity across income entries and mood events (user-scoped,
  // soft-delete aware). Two tiny aggregate queries; nothing here re-derives normalization.
  const [entryBounds, moodBounds] = await Promise.all([
    db('income_entries as e')
      .join('projects as p', 'p.id', 'e.project_id')
      .where('p.user_id', userId)
      .whereNull('p.deleted_at')
      .first<{ min_date: string | null; max_date: string | null } | undefined>(
        db.raw("DATE_FORMAT(MIN(e.date), '%Y-%m-%d') as min_date"),
        db.raw("DATE_FORMAT(MAX(e.date), '%Y-%m-%d') as max_date"),
      ),
    // Counts check-in ACTIVITY (which quarters have any data), so ALL kinds count — an untouched
    // answer is a check-in too (ticket 26). No kind filter here on purpose.
    db('mood_events')
      .where('user_id', userId)
      .whereNull('deleted_at')
      .first<{ min_date: string | null; max_date: string | null } | undefined>(
        db.raw("DATE_FORMAT(MIN(created_at), '%Y-%m-%d') as min_date"),
        db.raw("DATE_FORMAT(MAX(created_at), '%Y-%m-%d') as max_date"),
      ),
  ]);

  const mins = [entryBounds?.min_date, moodBounds?.min_date].filter(
    (d): d is string => typeof d === 'string',
  );
  const maxs = [entryBounds?.max_date, moodBounds?.max_date].filter(
    (d): d is string => typeof d === 'string',
  );
  if (mins.length === 0) return [];

  const earliest = quarterOf(mins.sort()[0]!);
  const latest = quarterOf(maxs.sort().at(-1)!);

  // Which quarters actually contain data (income entries or mood events). One grouped query each,
  // keyed by the quarter string derived in SQL (year, quarter number).
  const withData = new Set<string>();
  const quarterExpr = (col: string) => db.raw(`CONCAT(YEAR(${col}), '-Q', QUARTER(${col})) as q`);
  const [entryQuarters, moodQuarters] = await Promise.all([
    db('income_entries as e')
      .join('projects as p', 'p.id', 'e.project_id')
      .where('p.user_id', userId)
      .whereNull('p.deleted_at')
      .groupByRaw('YEAR(e.date), QUARTER(e.date)')
      .select<Array<{ q: string }>>(quarterExpr('e.date')),
    // Same "which quarters have data" activity count — ALL kinds count (ticket 26), no kind filter.
    db('mood_events')
      .where('user_id', userId)
      .whereNull('deleted_at')
      .groupByRaw('YEAR(created_at), QUARTER(created_at)')
      .select<Array<{ q: string }>>(quarterExpr('created_at')),
  ]);
  for (const r of entryQuarters) withData.add(r.q);
  for (const r of moodQuarters) withData.add(r.q);

  // Enumerate quarters from earliest to latest and keep the ones with data, newest first.
  const periods: StatementPeriod[] = [];
  let y = earliest.year;
  let q = earliest.quarter;
  for (;;) {
    const range = quarterRange(y, q);
    if (withData.has(range.period)) {
      periods.push({
        period: range.period,
        label: range.label,
        year: range.year,
        quarter: range.quarter,
        from: range.from,
        to: range.to,
        finished: range.to < today,
      });
    }
    if (y === latest.year && q === latest.quarter) break;
    if (q === 4) {
      q = 1;
      y++;
    } else {
      q++;
    }
  }

  return periods.reverse();
}
