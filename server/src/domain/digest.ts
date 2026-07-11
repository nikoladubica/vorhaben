import { randomBytes } from 'node:crypto';
import { db } from '../db/index.js';
import { computeMetricsForUser } from './metrics.js';
import { buildSignalsForUser } from './signals.js';
import type { ProjectMetrics } from './normalization.js';

// ---------------------------------------------------------------------------
// Monthly email digest model (ticket 16; BUSINESS_LOGIC §7/§8, design screen 13)
// ---------------------------------------------------------------------------
//
// The digest is the product's ONE proactive touchpoint: opt-in, one run per month, phrased as
// observations not predictions (§7). This module is split exactly like statement.ts ↔
// moodAnalysis.ts / signals.ts:
//
//   - PURE assembly (assembleDigest) — plain data in, plain data out, no Knex, no Express, no
//     clock. Given fixtures it is DETERMINISTIC, so it is fully exercised by digest.test.ts.
//   - the DB-facing loader (buildDigestForUser) — loads the month's normalization metrics (never
//     re-deriving §2.2), the previous month's, the year's monthly totals for the "best month" flag,
//     and the live mood signals, then hands fixtures to the pure core.
//
// NO LLM. The content (best performer, trend, one suggestion) reuses the SAME heuristics the
// dashboard, signals and statement already produce — identical self-hosted and hosted (§7: the
// heuristics work fully without the LLM). The gateway's `digest` feature/reserve (ticket 12) exists
// for a FUTURE LLM narration of these findings; v1 does not call it, so the job needs no API key.
//
// Money+mood pairing (ticket step 2): when the mood engine has a top finding for a project, the
// "needs attention" row and the one suggestion prefer it over a pure revenue decline — that pairing
// is the product's voice. The engine's sentence is reused VERBATIM (never re-authored here); this
// module only adds the revenue number next to it.

// Month names, index 0 = January. Used for labels/subjects; avoids Date/timezone drift.
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const PERIOD_RE = /^(\d{4})-(\d{2})$/;

export interface MonthPeriod {
  year: number;
  month: number; // 1–12
  period: string; // "2026-06"
  label: string; // "June"
  longLabel: string; // "June 2026"
  from: string; // 'YYYY-MM-DD' first day of the month
  to: string; // 'YYYY-MM-DD' last day of the month
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// Last calendar day of a 1-based month, UTC-anchored (day 0 of the next month rolls back one).
function lastDayOfMonth(year: number, month1: number): string {
  const d = new Date(Date.UTC(year, month1, 0));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Build the {@link MonthPeriod} for a year + month (1–12). Pure; no clock. */
export function monthPeriod(year: number, month: number): MonthPeriod {
  const label = MONTH_NAMES[month - 1] ?? '';
  return {
    year,
    month,
    period: `${year}-${pad2(month)}`,
    label,
    longLabel: `${label} ${year}`,
    from: `${year}-${pad2(month)}-01`,
    to: lastDayOfMonth(year, month),
  };
}

/** Parse a "YYYY-MM" period string, or null when malformed or the month is out of range. Pure. */
export function parseMonthPeriod(period: string): MonthPeriod | null {
  const m = PERIOD_RE.exec(period);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return monthPeriod(Number(m[1]), month);
}

/**
 * The full calendar month BEFORE `now` — the period a digest run covers (a run on 2026-07-01
 * reports June 2026). Pure apart from the caller-supplied clock.
 */
export function previousMonthPeriod(now: Date = new Date()): MonthPeriod {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1; // 1–12, current month
  return month === 1 ? monthPeriod(year - 1, 12) : monthPeriod(year, month - 1);
}

// ---------------------------------------------------------------------------
// Pure assembly — inputs and output shapes
// ---------------------------------------------------------------------------

export interface DigestProjectInput {
  projectId: number;
  name: string;
  // The target month's monthly-equivalent figures (from metrics.ts; already §2.2-normalized).
  monthlyNet: number | null;
  effectiveHourlyRate: number | null;
  // The PREVIOUS month's monthly-equivalent net, for the revenue-decline detail. null when unknown.
  prevMonthlyNet: number | null;
}

// The mood engine's top finding for the portfolio (signals.ts), mapped to just what the digest
// needs. `sentence` is the engine's verbatim First-Signal line — reused, never re-authored.
export interface DigestTopSignal {
  projectId: number;
  name: string;
  sentence: string;
}

export interface DigestInput {
  period: MonthPeriod;
  baseCurrency: string;
  projects: DigestProjectInput[];
  // Portfolio monthly-equivalent net for each month of the target YEAR, index 0 = January through
  // the target month inclusive (so the last element is the target month's own total). null = a
  // month with no comparable figure. Drives the "best month of <year>" flag.
  monthTotals: (number | null)[];
  topSignal: DigestTopSignal | null;
}

export interface DigestLeader {
  project_id: number;
  name: string;
  value: number; // money (net) or rate, per field
}

export interface DigestAttention {
  project_id: number;
  name: string;
  detail: string; // e.g. "−18% vs May", or "worth a look" when no prior figure exists
}

export interface DigestModel {
  period: string; // "2026-06"
  month_label: string; // "June"
  long_label: string; // "June 2026"
  base_currency: string;
  monthly_equivalent: number | null; // portfolio monthly-equivalent net for the month
  mom_delta: number | null; // absolute change vs the previous month
  mom_percent: number | null; // percentage change vs the previous month (1 dp)
  is_best_month: boolean; // the year's highest monthly total so far (needs a prior month to compare)
  best_by_rate: DigestLeader | null;
  biggest_earner: DigestLeader | null;
  needs_attention: DigestAttention | null;
  suggestion: string | null; // one observation sentence, or null when there is nothing to say
  // False when the user has no comparable figures at all — the job skips sending an empty digest.
  has_content: boolean;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// Highest project by a nullable metric; null when none qualifies. Ties keep the earlier entry
// (callers pass projects in a stable order), matching statement.ts's leaderBy.
function leaderBy(
  projects: DigestProjectInput[],
  pick: (p: DigestProjectInput) => number | null,
): DigestLeader | null {
  let best: DigestLeader | null = null;
  for (const p of projects) {
    const v = pick(p);
    if (v === null) continue;
    if (best === null || v > best.value) {
      best = { project_id: p.projectId, name: p.name, value: v };
    }
  }
  return best;
}

// The month label immediately before the target period (for "vs May" phrasing).
function prevMonthLabel(period: MonthPeriod): string {
  const prev = period.month === 1 ? 12 : period.month - 1;
  return MONTH_NAMES[prev - 1] ?? '';
}

// A project's month-over-month revenue decline as a NEGATIVE integer percent, or null when it did
// not decline or there is no positive prior figure to divide by.
function declinePercent(p: DigestProjectInput): number | null {
  if (p.prevMonthlyNet === null || p.prevMonthlyNet <= 0) return null;
  const curr = p.monthlyNet ?? 0;
  if (curr >= p.prevMonthlyNet) return null;
  return Math.round(((curr - p.prevMonthlyNet) / p.prevMonthlyNet) * 100); // negative
}

/**
 * Assemble the digest model from already-loaded, already-normalized figures. Pure and
 * deterministic. Observations only — never a prediction (§7).
 */
export function assembleDigest(input: DigestInput): DigestModel {
  const { period, baseCurrency, projects, monthTotals, topSignal } = input;

  // Portfolio total = sum of the month's monthly-equivalent net across projects with a figure.
  const netValues = projects.map((p) => p.monthlyNet).filter((v): v is number => v !== null);
  const monthlyEquivalent = netValues.length === 0 ? null : roundMoney(netValues.reduce((a, b) => a + b, 0));

  // MoM delta vs the previous month's portfolio total (index month-2 in monthTotals).
  const prevTotal = period.month >= 2 ? (monthTotals[period.month - 2] ?? null) : null;
  let momDelta: number | null = null;
  let momPercent: number | null = null;
  if (monthlyEquivalent !== null && prevTotal !== null) {
    momDelta = roundMoney(monthlyEquivalent - prevTotal);
    if (prevTotal !== 0) momPercent = round1(((monthlyEquivalent - prevTotal) / Math.abs(prevTotal)) * 100);
  }

  // "Best month of the year": the target total is at least as high as every EARLIER month this
  // year, and at least one earlier month has a figure to compare against (so January never claims
  // it, and a single data point isn't crowned).
  const earlier = monthTotals.slice(0, Math.max(0, period.month - 1));
  const earlierWithData = earlier.filter((v): v is number => v !== null);
  const isBestMonth =
    monthlyEquivalent !== null &&
    monthlyEquivalent > 0 &&
    earlierWithData.length > 0 &&
    earlierWithData.every((t) => monthlyEquivalent >= t);

  const bestByRate = leaderBy(projects, (p) => p.effectiveHourlyRate);
  const biggestEarner = leaderBy(projects, (p) => p.monthlyNet);

  // Needs-attention + suggestion. The mood engine's top finding wins; otherwise fall back to the
  // sharpest revenue decline. The row carries the revenue number for the chosen project when there
  // is one; the suggestion carries the engine's verbatim sentence, else a revenue observation.
  let needsAttention: DigestAttention | null = null;
  let suggestion: string | null = null;

  const declines = projects
    .map((p) => ({ p, pct: declinePercent(p) }))
    .filter((d): d is { p: DigestProjectInput; pct: number } => d.pct !== null)
    .sort((a, b) => a.pct - b.pct); // most negative first

  if (topSignal) {
    const flagged = projects.find((p) => p.projectId === topSignal.projectId);
    const pct = flagged ? declinePercent(flagged) : null;
    needsAttention = {
      project_id: topSignal.projectId,
      name: topSignal.name,
      detail: pct !== null ? `${pct}% vs ${prevMonthLabel(period)}` : 'worth a look',
    };
    suggestion = topSignal.sentence; // verbatim from the engine
  } else if (declines.length > 0) {
    const { p, pct } = declines[0]!;
    needsAttention = {
      project_id: p.projectId,
      name: p.name,
      detail: `${pct}% vs ${prevMonthLabel(period)}`,
    };
    // A revenue-only observation (never a prediction): state what changed, suggest a look.
    suggestion = `${p.name} brought in ${Math.abs(pct)}% less than ${prevMonthLabel(period)} — worth a look before you put more time into it.`;
  }

  const hasContent =
    monthlyEquivalent !== null || bestByRate !== null || biggestEarner !== null;

  return {
    period: period.period,
    month_label: period.label,
    long_label: period.longLabel,
    base_currency: baseCurrency,
    monthly_equivalent: monthlyEquivalent,
    mom_delta: momDelta,
    mom_percent: momPercent,
    is_best_month: isBestMonth,
    best_by_rate: bestByRate,
    biggest_earner: biggestEarner,
    needs_attention: needsAttention,
    suggestion,
    has_content: hasContent,
  };
}

// ---------------------------------------------------------------------------
// DB-facing loader
// ---------------------------------------------------------------------------

interface ProjectMetaRow {
  id: number;
  name: string;
}

// Sum the monthly-equivalent net across an entire metrics map — a month's portfolio total.
function sumMonthlyNet(metrics: Map<number, ProjectMetrics>): number | null {
  let total: number | null = null;
  for (const m of metrics.values()) {
    if (m.monthlyNet === null || m.monthlyNet === undefined) continue;
    total = (total ?? 0) + m.monthlyNet;
  }
  return total;
}

/**
 * Build the digest model for `userId` + `period` ("YYYY-MM"), computed on demand. Returns null when
 * the period string is malformed. Every query is user-scoped and soft-delete aware; all money is
 * converted to the user's base currency through metrics.ts.
 *
 * Query note: the "best month of the year" flag needs each month's portfolio total, so this calls
 * computeMetricsForUser once per month from January through the target month. That is bounded
 * (≤ 12) and this runs in a once-a-month one-shot job, never on a request path — correctness and
 * consistency with §2.2 win over shaving reads here.
 */
export async function buildDigestForUser(
  userId: number,
  period: string,
): Promise<DigestModel | null> {
  const target = parseMonthPeriod(period);
  if (target === null) return null;

  // 1. Base currency.
  const user = await db('users').where('id', userId).first<{ base_currency: string } | undefined>('base_currency');
  const baseCurrency = user?.base_currency ?? 'EUR';

  // 2. Non-deleted projects whose lifespan overlaps the target month (started on/before the month
  //    end and not ended before it began). Scoped by user_id. These are the leader/attention candidates.
  const projectMeta = await db('projects')
    .where('user_id', userId)
    .whereNull('deleted_at')
    .andWhere('start_date', '<=', target.to)
    .andWhere((qb) => qb.whereNull('end_date').orWhere('end_date', '>=', target.from))
    .select<ProjectMetaRow[]>('id', 'name');

  // 3. Per-month portfolio totals for the year (Jan..target), reusing the target month's metrics for
  //    the project figures. Each call re-uses metrics.ts — normalization is never re-derived here.
  const monthTotals: (number | null)[] = [];
  let targetMetrics: Map<number, ProjectMetrics> = new Map();
  let prevMetrics: Map<number, ProjectMetrics> = new Map();
  for (let m = 1; m <= target.month; m++) {
    const range = monthPeriod(target.year, m);
    const metrics = await computeMetricsForUser(userId, { from: range.from, to: range.to });
    monthTotals.push(sumMonthlyNet(metrics));
    if (m === target.month) targetMetrics = metrics;
    if (m === target.month - 1) prevMetrics = metrics;
  }

  // 4. The mood engine's top finding (signals.ts orders most-concerning first). On-demand, never
  //    re-derived. undefined → no signal worth pairing.
  const signals = await buildSignalsForUser(userId);
  const top = signals[0];
  const topSignal: DigestTopSignal | null = top
    ? { projectId: top.project_id, name: top.name, sentence: top.sentence }
    : null;

  // 5. Materialize per-project inputs and hand fixtures to the pure core.
  const projects: DigestProjectInput[] = projectMeta.map((meta) => ({
    projectId: meta.id,
    name: meta.name,
    monthlyNet: targetMetrics.get(meta.id)?.monthlyNet ?? null,
    effectiveHourlyRate: targetMetrics.get(meta.id)?.effectiveHourlyRate ?? null,
    prevMonthlyNet: prevMetrics.get(meta.id)?.monthlyNet ?? null,
  }));

  return assembleDigest({ period: target, baseCurrency, projects, monthTotals, topSignal });
}

// ---------------------------------------------------------------------------
// Unsubscribe token
// ---------------------------------------------------------------------------

/**
 * Ensure `userId` has an unguessable unsubscribe token, generating one if the column is still null
 * (e.g. a user who signed up after the migration's backfill). Returns the token. 32 random bytes →
 * 43 base64url chars.
 */
export async function ensureUnsubToken(userId: number): Promise<string> {
  const row = await db('users').where('id', userId).first<{ digest_unsub_token: string | null } | undefined>('digest_unsub_token');
  const existing = row?.digest_unsub_token;
  if (existing) return existing;
  const token = randomBytes(32).toString('base64url');
  await db('users').where('id', userId).update({ digest_unsub_token: token });
  return token;
}
