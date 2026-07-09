import { db } from '../db/index.js';
import type { CompensationModel } from './constants.js';

// ---------------------------------------------------------------------------
// Expected-entry generation (BUSINESS_LOGIC.md §2.1) — lazy, idempotent
// ---------------------------------------------------------------------------
//
// Salaried models don't get a special revenue path in the normalization engine (see the note in
// normalization.ts): their ×26÷12 / ×52÷12 / as-is factors emerge purely from how many entries
// land in the window. So for a salaried project to show any revenue at all, the elapsed pay
// periods must exist as income_entries. Rather than run a scheduler, we MATERIALIZE the missing
// periods lazily whenever a salaried project's entries are read or its metrics are computed.
//
// The period math (expectedPeriods) is PURE — no Knex, no Express — and unit-tested with
// fixtures, mirroring normalization.ts. ensureExpectedEntries is the DB-facing half.

// Compensation models that auto-generate expected entries. The single source of truth for
// "is this salaried?"; metrics.ts imports isSalaried rather than re-listing these.
export const SALARIED_MODELS = new Set<CompensationModel>([
  'salary_monthly',
  'salary_biweekly',
  'salary_weekly',
]);

export function isSalaried(model: CompensationModel): boolean {
  return SALARIED_MODELS.has(model);
}

// One materialized/expected pay period: a period-start date plus the amount+currency it carries.
export interface ExpectedPeriod {
  date: string; // 'YYYY-MM-DD' period-start date (1st of month / Monday / biweekly anchor)
  amount: string; // = project rate_amount, verbatim
  currency: string; // resolved currency (rate_currency → user base)
}

/**
 * Enumerate the period-start dates a salaried project should have expected entries for. PURE.
 *
 * Emits every period-START date D with `startDate ≤ D ≤ min(today, endDate)`:
 *   • salary_monthly  → the 1st of each month.
 *   • salary_weekly   → each Monday (first Monday ≥ start, then +7 days).
 *   • salary_biweekly → every second Monday, anchored at the first Monday ≥ start (then +14 days).
 *
 * The bounds test the period START, so a project ending mid-period still emits that period's
 * entry ("final period generated on its start date"). A future start_date (or an `idea` project
 * that hasn't begun) yields `[]`, as does any non-salaried model. Every element carries
 * `rateAmount` / `rateCurrency` verbatim. Date strings are 'YYYY-MM-DD' and compare
 * lexicographically, so bound checks are plain string comparisons.
 */
export function expectedPeriods(
  model: CompensationModel,
  startDate: string,
  endDate: string | null,
  today: string,
  rateAmount: string,
  rateCurrency: string,
): ExpectedPeriod[] {
  if (!SALARIED_MODELS.has(model)) return [];

  // Upper bound: never generate beyond today, and never past the project's end date.
  const upper = endDate !== null && endDate < today ? endDate : today;

  const dates: string[] =
    model === 'salary_monthly'
      ? monthlyStarts(startDate, upper)
      : weeklyStarts(startDate, upper, model === 'salary_biweekly' ? 14 : 7);

  return dates.map((date) => ({ date, amount: rateAmount, currency: rateCurrency }));
}

// 1st-of-month dates in [startDate, upper]. The first period start is the earliest month-1st
// that is ≥ startDate (startDate's own month when it starts on the 1st, else the next month).
function monthlyStarts(startDate: string, upper: string): string[] {
  const { year, month, day } = parseDate(startDate);
  let y = year;
  let m = month;
  if (day > 1) {
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  const out: string[] = [];
  let date = `${y}-${pad2(m)}-01`;
  while (date <= upper) {
    out.push(date);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    date = `${y}-${pad2(m)}-01`;
  }
  return out;
}

// Monday-aligned dates in [startDate, upper], stepping `stepDays` (7 weekly, 14 biweekly). The
// anchor is the first Monday ≥ startDate; biweekly phase is fixed by that same anchor.
function weeklyStarts(startDate: string, upper: string, stepDays: number): string[] {
  const out: string[] = [];
  let ms = firstMondayOnOrAfter(startDate);
  let date = fromUtcMs(ms);
  while (date <= upper) {
    out.push(date);
    ms += stepDays * 86_400_000;
    date = fromUtcMs(ms);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Materialization (DB-facing)
// ---------------------------------------------------------------------------

// Project fields needed to decide what to generate. Decimals arrive as strings from mysql2.
interface SalariedProjectRow {
  id: number;
  user_id: number;
  compensation_model: CompensationModel;
  start_date: string;
  end_date: string | null;
  rate_amount: string | null;
  rate_currency: string | null;
  deleted_at: Date | null;
}

/**
 * Ensure a salaried project has an expected income_entry for every elapsed pay period, inserting
 * only the missing ones. Idempotent and safe under concurrent first-loads: the whole read-then-
 * insert runs inside a transaction that takes a `SELECT … FOR UPDATE` row lock on the project.
 * There is deliberately NO unique index on income_entries (two manual entries may legitimately
 * share a date), so that row lock — not a DB constraint — is what serializes concurrent callers.
 * A no-op for soft-deleted, non-salaried, or rate-less projects.
 */
export async function ensureExpectedEntries(projectId: number): Promise<void> {
  await db.transaction(async (trx) => {
    // Lock the project row so two parallel first-loads can't both read "nothing exists" and
    // double-insert. dates DATE_FORMAT to 'YYYY-MM-DD' strings, matching the rest of the codebase.
    const project = (await trx('projects')
      .where('id', projectId)
      .forUpdate()
      .first(
        'id',
        'user_id',
        'compensation_model',
        trx.raw("DATE_FORMAT(start_date, '%Y-%m-%d') as start_date"),
        trx.raw("DATE_FORMAT(end_date, '%Y-%m-%d') as end_date"),
        'rate_amount',
        'rate_currency',
        'deleted_at',
      )) as SalariedProjectRow | undefined;

    if (!project) return;
    // Soft-deleted projects generate nothing (reads/writes on them 404 at the route layer anyway).
    if (project.deleted_at != null) return;
    if (!isSalaried(project.compensation_model)) return;
    // Without a rate there is no amount to put on the expected entry.
    if (project.rate_amount == null) return;

    // Currency fallback mirrors the POST /entries route: project rate currency → user base.
    let currency = project.rate_currency ?? null;
    if (!currency) {
      const user = await trx('users').where('id', project.user_id).first('base_currency');
      currency = (user as { base_currency: string }).base_currency;
    }

    const today = new Date().toISOString().slice(0, 10);
    const periods = expectedPeriods(
      project.compensation_model,
      project.start_date,
      project.end_date,
      today,
      String(project.rate_amount),
      currency,
    );
    if (periods.length === 0) return;

    // Existing entries of ANY source suppress the expected duplicate — a manually typed paycheck
    // on a period-start date means we must NOT also generate the expected one.
    const existingRows = (await trx('income_entries')
      .where('project_id', projectId)
      .select(trx.raw("DATE_FORMAT(date, '%Y-%m-%d') as date"))) as { date: string }[];
    const existing = new Set(existingRows.map((r) => r.date));

    // Tombstoned periods (an expected entry the user deleted) must never regenerate.
    const suppressedRows = (await trx('suppressed_expected_entries')
      .where('project_id', projectId)
      .select(trx.raw("DATE_FORMAT(period_date, '%Y-%m-%d') as period_date"))) as {
      period_date: string;
    }[];
    const suppressed = new Set(suppressedRows.map((r) => r.period_date));

    const missing = periods.filter((p) => !existing.has(p.date) && !suppressed.has(p.date));
    if (missing.length === 0) return; // Knex rejects an empty insert; also saves a round-trip.

    await trx('income_entries').insert(
      missing.map((p) => ({
        project_id: projectId,
        date: p.date,
        amount: p.amount,
        currency: p.currency,
        note: null,
        source: 'expected',
      })),
    );
  });
}

// ---------------------------------------------------------------------------
// Date helpers (UTC-anchored; 'YYYY-MM-DD' strings) — mirrors normalization.ts
// ---------------------------------------------------------------------------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDate(date: string): { year: number; month: number; day: number } {
  const match = DATE_RE.exec(date);
  if (!match) throw new Error(`expectedEntries: invalid date '${date}'`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function toUtcMs(date: string): number {
  const { year, month, day } = parseDate(date);
  return Date.UTC(year, month - 1, day);
}

function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// The first Monday on or after `date`, as UTC midnight ms. getUTCDay: 0=Sun … 1=Mon … 6=Sat;
// (1 - dow + 7) % 7 is the days forward to the next Monday (0 when `date` is already Monday).
function firstMondayOnOrAfter(date: string): number {
  const ms = toUtcMs(date);
  const dow = new Date(ms).getUTCDay();
  const daysToMonday = (1 - dow + 7) % 7;
  return ms + daysToMonday * 86_400_000;
}
