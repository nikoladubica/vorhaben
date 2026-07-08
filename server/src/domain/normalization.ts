import type { CompensationModel } from './constants.js';

// ---------------------------------------------------------------------------
// Normalization engine (BUSINESS_LOGIC.md §2.2) — PURE computation
// ---------------------------------------------------------------------------
//
// This module holds the product's comparison math and NOTHING else: no Knex, no Express, no
// env. It takes already-converted entries (base-currency numbers produced by domain/fx.ts) plus
// time logs and returns the two headline figures the dashboard ranks on — monthly-equivalent
// revenue and effective hourly rate. Because it is pure, it is fully exercised by
// normalization.test.ts with fixtures alone; metrics.ts is the thin DB-facing adapter that
// feeds it.
//
// PRODUCT DEFINITIONS (these are decisions, not incidental implementation details):
//
//  • Window. The comparison window is the trailing 3 calendar months ending at the reference
//    date `asOf` — i.e. [asOf − 3 months, asOf]. It is SHORTENED to the project's active months
//    when the project is younger than that: the window's `from` is clamped up to the project's
//    start_date, so a 45-day-old project is measured over its own 45 days, not a full quarter.
//    Callers may pass an explicit { from, to } window (e.g. the dashboard's own range); it is
//    still clamped to the project's start_date so a young project never divides by more months
//    than it has existed.
//
//  • Monthly-equivalent revenue. Sum of the entries that fall inside the window (each already
//    converted to base currency at its own date) ÷ the window length in months.
//    EXCEPTION — the `fixed` model only: total of ALL of the project's entries ÷ the project's
//    full duration in months (start_date → end_date, or → `asOf` while ongoing). A one-time
//    fixed payment is amortized across the whole engagement, not the trailing window. No other
//    model — salaried included — gets a special revenue path: salary_biweekly/weekly amounts
//    manifest their ×26÷12 / ×52÷12 factors purely through the entry amounts the user (or the
//    auto-generator) records, and flow through the same windowed sum as everything else.
//
//  • Effective hourly rate. WINDOWED converted revenue ÷ hours logged in the SAME window — for
//    every model, `fixed` included (the amortized monthly figure is never used here). It is
//    `null` when the window has zero logged hours: we never divide by zero and never fabricate a
//    rate from a nominal hourly rate the user configured.
//
//  • Month arithmetic. Fractional months = span-in-days ÷ 30.44 (the mean Gregorian month
//    length), so a 45-day span ≈ 1.478 months and the full trailing window ≈ 2.99 months.
//
//  • No rounding here. Everything stays at full floating precision; rounding to 2 decimals for
//    display is the API layer's job (ticket 09), not this module's.
//
// Money note: fx.ts does exact fixed-point BigInt math and hands us 2dp strings. metrics.ts
// turns those already-converted 2dp values into plain Numbers before they reach this layer.
// These are display metrics, not stored money, so summing Numbers here is acceptable and
// deliberate — no raw user amount is ever float-parsed; only fx.ts's rounded output is.

// Mean Gregorian month length in days — the single conversion factor for days → months.
const DAYS_PER_MONTH = 30.44;

// Trailing-window length in whole calendar months (before young-project shortening).
const DEFAULT_WINDOW_MONTHS = 3;

// ---------------------------------------------------------------------------
// Inputs (fixtures / DB rows, post-conversion)
// ---------------------------------------------------------------------------

export interface MetricsProject {
  // Only 'fixed' changes the revenue path; every other model is treated identically.
  compensationModel: CompensationModel;
  startDate: string; // 'YYYY-MM-DD'
  endDate: string | null; // 'YYYY-MM-DD' or null when ongoing
}

export interface MetricsEntry {
  date: string; // 'YYYY-MM-DD'
  converted: number; // amount already converted to base currency by fx.ts
  missingRate: boolean; // fx.ts flagged this pair as having no rate (converted == original)
}

export interface MetricsTimeLog {
  date: string; // 'YYYY-MM-DD'
  hours: number;
}

export interface NormalizationOptions {
  // Reference "today": bounds the default window and closes an ongoing fixed project's duration.
  asOf: string; // 'YYYY-MM-DD'
  // Optional explicit window; still clamped to the project's start_date.
  window?: { from: string; to: string };
}

// ---------------------------------------------------------------------------
// Output (exact shape consumed by tickets 09 & 10)
// ---------------------------------------------------------------------------

export interface ProjectMetrics {
  monthlyRevenue: number | null; // null when no contributing entries exist for the window
  effectiveHourlyRate: number | null; // null when no hours were logged in the window
  hoursInWindow: number;
  entryCount: number; // contributing entries: windowed for most models, ALL for `fixed`
  missingRates: boolean; // any contributing entry fell back unconverted (fx missing_rate)
  window: { from: string; to: string; months: number };
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Compute the monthly-equivalent revenue and effective hourly rate for a single project.
 *
 * @param project  compensation model + lifecycle dates (drives fixed amortization + shortening).
 * @param entries  ALL of the project's entries, already converted to base currency. The window
 *                 filter is applied here, so callers hand over the full set (the `fixed` path
 *                 needs every entry, and letting this layer window keeps the date logic testable).
 * @param timeLogs ALL of the project's time logs; windowed here.
 * @param options  reference date + optional explicit window.
 */
export function computeProjectMetrics(
  project: MetricsProject,
  entries: MetricsEntry[],
  timeLogs: MetricsTimeLog[],
  options: NormalizationOptions,
): ProjectMetrics {
  const { asOf } = options;

  // --- Window resolution -------------------------------------------------
  const to = options.window?.to ?? asOf;
  const rawFrom = options.window?.from ?? subtractMonths(to, DEFAULT_WINDOW_MONTHS);
  // Shorten to the project's active months: never start the window before the project existed.
  const from = maxDate(rawFrom, project.startDate);

  const windowDays = Math.max(0, daysBetween(from, to));
  const windowMonths = windowDays / DAYS_PER_MONTH;

  // --- Windowed aggregates ----------------------------------------------
  const windowedEntries = entries.filter((e) => e.date >= from && e.date <= to);
  const windowedRevenue = sumConverted(windowedEntries);

  let hoursInWindow = 0;
  for (const log of timeLogs) {
    if (log.date >= from && log.date <= to) hoursInWindow += log.hours;
  }

  // --- Contributing set (drives entryCount, missingRates, monthlyRevenue) -
  const isFixed = project.compensationModel === 'fixed';
  const contributingEntries = isFixed ? entries : windowedEntries;
  const entryCount = contributingEntries.length;
  const missingRates = contributingEntries.some((e) => e.missingRate);

  // --- Monthly-equivalent revenue ---------------------------------------
  let monthlyRevenue: number | null;
  if (entryCount === 0) {
    // No data to normalize for this window/project.
    monthlyRevenue = null;
  } else if (isFixed) {
    // Amortize the total over the whole engagement, not the trailing window.
    const durationEnd = project.endDate ?? asOf;
    const durationMonths = Math.max(0, daysBetween(project.startDate, durationEnd)) / DAYS_PER_MONTH;
    monthlyRevenue = durationMonths > 0 ? sumConverted(entries) / durationMonths : null;
  } else {
    monthlyRevenue = windowMonths > 0 ? windowedRevenue / windowMonths : null;
  }

  // --- Effective hourly rate --------------------------------------------
  // Always windowed revenue over windowed hours; never the amortized figure, never zero-divide.
  const effectiveHourlyRate = hoursInWindow > 0 ? windowedRevenue / hoursInWindow : null;

  return {
    monthlyRevenue,
    effectiveHourlyRate,
    hoursInWindow,
    entryCount,
    missingRates,
    window: { from, to, months: windowMonths },
  };
}

function sumConverted(entries: MetricsEntry[]): number {
  let total = 0;
  for (const entry of entries) total += entry.converted;
  return total;
}

// ---------------------------------------------------------------------------
// Date helpers (UTC-anchored; 'YYYY-MM-DD' strings in and out)
// ---------------------------------------------------------------------------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDate(date: string): { year: number; month: number; day: number } {
  const match = DATE_RE.exec(date);
  if (!match) throw new Error(`normalization: invalid date '${date}'`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

// Whole-day difference (to − from), computed at UTC midnight so DST never shifts the count.
function daysBetween(from: string, to: string): number {
  const { year: fy, month: fm, day: fd } = parseDate(from);
  const { year: ty, month: tm, day: td } = parseDate(to);
  const fromMs = Date.UTC(fy, fm - 1, fd);
  const toMs = Date.UTC(ty, tm - 1, td);
  return Math.round((toMs - fromMs) / 86_400_000);
}

// Subtract whole calendar months, clamping the day to the target month's length
// (e.g. 2026-05-31 − 3 months → 2026-02-28).
function subtractMonths(date: string, months: number): string {
  const { year, month, day } = parseDate(date);
  let monthIndex = month - 1 - months; // 0-based, may go negative
  let targetYear = year + Math.floor(monthIndex / 12);
  monthIndex = ((monthIndex % 12) + 12) % 12;
  // Day 0 of the following month = last day of the target month.
  const daysInTargetMonth = new Date(Date.UTC(targetYear, monthIndex + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, daysInTargetMonth);
  return `${targetYear}-${pad2(monthIndex + 1)}-${pad2(clampedDay)}`;
}

// Lexicographic max works for zero-padded 'YYYY-MM-DD' (string order == chronological order).
function maxDate(a: string, b: string): string {
  return a >= b ? a : b;
}
