// ---------------------------------------------------------------------------
// Focus suggestion heuristics (BUSINESS_LOGIC.md §4.2) — PURE rules
// ---------------------------------------------------------------------------
//
// The dashboard's plain-language focus callout is rules-based in v1. Per §7 the future LLM path
// "augments, never gates" — so these four heuristics live here as a pure function that takes
// plain data in and returns plain data out: no Knex, no Express, no fx, no env. The DB-facing
// assembler (buildSuggestionsForUser in domain/dashboard.ts) loads the numbers and hands them
// over; this module only decides which rules fire and phrases them. Because it is pure it is
// fully exercised by suggestions.test.ts with fixtures alone, and the LLM variant can later wrap
// or replace this behind the identical Suggestion[] shape.
//
// The four v1 rules (thresholds are the named constants below):
//   1. top_hourly  (info)    — the active project with the highest effective hourly rate, only
//                              when ≥2 active projects have one (a ranking of one is noise).
//   2. declining   (warning) — an active project whose last full month revenue fell below 70% of
//                              its average over the two months before that.
//   3. revive      (info)    — an ended project whose monthly revenue over its own last 3 active
//                              months beats every active project's windowed monthly revenue.
//   4. concentration (warning) — one project supplying >60% of converted income over the last
//                              3 months, when more than one project has income.
//
// All money figures arrive already converted to the user's base currency. Messages are full
// sentences with real numbers and the base-currency symbol/code — no placeholders, no rule
// jargon — ready to render as-is.

// --- Rule thresholds (the §4.2 precision, kept in one place) ---------------

// Rule 1: a "highest rate" callout needs at least this many rated active projects to be signal.
const MIN_RATED_ACTIVE_FOR_TOP_HOURLY = 2;
// Rule 2: flag when last full month < this fraction of the prior two-month average.
const DECLINE_RATIO = 0.7;
// Rule 3 & 4: the trailing window, in whole calendar months, for revenue comparisons.
const WINDOW_MONTHS = 3;
// Rule 4: flag when one project's share of windowed income exceeds this fraction.
const CONCENTRATION_SHARE = 0.6;

// Base-currency codes we render with a leading symbol; everything else uses a trailing code
// (e.g. "1,200 SEK"). Kept deliberately small — matching the design system's restraint.
const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '€',
  USD: '$',
  GBP: '£',
  JPY: '¥',
};

// ---------------------------------------------------------------------------
// Inputs (plain data; the assembler in dashboard.ts fills these from the DB)
// ---------------------------------------------------------------------------

export interface SuggestionProject {
  projectId: number;
  name: string;
  // Lifecycle status: 'active' | 'paused' | 'ended' | 'idea'. Rules 1–3 look only at 'active'
  // (and 'ended' for rule 3); rule 4 counts every project with income.
  status: string;
  // Canonical windowed effective hourly rate (from computeMetricsForUser); null when no hours
  // were logged in the window. Drives rule 1 only.
  effectiveHourlyRate: number | null;
  // 'YYYY-MM' of the project's end date, or null when ongoing. Anchors rule 3's own-window.
  endMonth: string | null;
  // Converted base-currency revenue bucketed by calendar month ('YYYY-MM' → total). Sparse:
  // months with no income are simply absent. Powers rules 2, 3 and 4.
  revenueByMonth: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Output (the exact JSON contract the endpoint returns and the client renders)
// ---------------------------------------------------------------------------

export interface Suggestion {
  rule: 'top_hourly' | 'declining' | 'revive' | 'concentration';
  severity: 'info' | 'warning';
  message: string; // full sentence, ready to render
  project_ids: number[];
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Run the four v1 focus heuristics over a user's per-project figures.
 *
 * @param projects     one record per non-deleted project, already converted to base currency.
 * @param asOf         reference "today" as 'YYYY-MM-DD'; fixes the "last full month" and windows.
 * @param baseCurrency the user's base currency code (for message formatting).
 * @returns the fired suggestions, warnings first (empty array is a valid, common result).
 */
export function buildSuggestions(
  projects: SuggestionProject[],
  asOf: string,
  baseCurrency: string,
): Suggestion[] {
  const out: Suggestion[] = [];
  if (projects.length === 0) return out;

  // The last COMPLETE calendar month; the current (partial) month is excluded from every
  // revenue comparison so a mid-month reading never looks like a decline.
  const lastFull = lastFullMonth(asOf);

  const activeProjects = projects.filter((p) => p.status === 'active');

  // --- Rule 1: top_hourly (info) ----------------------------------------
  const ratedActive = activeProjects
    .filter((p) => p.effectiveHourlyRate !== null)
    .sort((a, b) => (b.effectiveHourlyRate as number) - (a.effectiveHourlyRate as number));
  const top = ratedActive[0];
  const runner = ratedActive[1];
  if (ratedActive.length >= MIN_RATED_ACTIVE_FOR_TOP_HOURLY && top && runner) {
    const topRate = top.effectiveHourlyRate as number;
    const runnerRate = runner.effectiveHourlyRate as number;
    // Only a callout when there is a clear leader and a positive baseline to multiply against.
    if (runnerRate > 0 && topRate > runnerRate) {
      const multiple = formatMultiple(topRate / runnerRate);
      out.push({
        rule: 'top_hourly',
        severity: 'info',
        message:
          `${top.name} earns your highest effective hourly rate at ${money(topRate, baseCurrency)}/h ` +
          `— ${multiple}× your rate at ${runner.name} (${money(runnerRate, baseCurrency)}/h). ` +
          `Consider doing more of this.`,
        project_ids: [top.projectId, runner.projectId],
      });
    }
  }

  // --- Rule 2: declining (warning) --------------------------------------
  const prior1 = monthKeyFromIndex(monthIndex(lastFull) - 1);
  const prior2 = monthKeyFromIndex(monthIndex(lastFull) - 2);
  for (const p of activeProjects) {
    const last = revenueIn(p, lastFull);
    const priorAvg = (revenueIn(p, prior1) + revenueIn(p, prior2)) / 2;
    if (priorAvg > 0 && last < DECLINE_RATIO * priorAvg) {
      out.push({
        rule: 'declining',
        severity: 'warning',
        message:
          `${p.name} brought in ${money(last, baseCurrency)} last month, down from a ` +
          `${money(priorAvg, baseCurrency)} monthly average over the two months before. ` +
          `Worth checking on.`,
        project_ids: [p.projectId],
      });
    }
  }

  // --- Rule 3: revive (info) --------------------------------------------
  // Each active project's windowed monthly revenue = its last 3 full months averaged. Compared
  // like-for-like against an ended project's own last 3 active months.
  const activeMonthly = activeProjects.map((p) => windowedMonthly(p, lastFull));
  if (activeMonthly.length > 0) {
    const bestActive = Math.max(...activeMonthly);
    let revive: { project: SuggestionProject; monthly: number } | null = null;
    for (const p of projects) {
      if (p.status !== 'ended' || p.endMonth === null) continue;
      const monthly = windowedMonthly(p, p.endMonth);
      if (monthly > 0 && monthly > bestActive && (revive === null || monthly > revive.monthly)) {
        revive = { project: p, monthly };
      }
    }
    if (revive !== null) {
      out.push({
        rule: 'revive',
        severity: 'info',
        message:
          `${revive.project.name} (now ended) averaged ${money(revive.monthly, baseCurrency)}/month ` +
          `over its final active quarter — more than any active project earns today. ` +
          `Consider reviving it.`,
        project_ids: [revive.project.projectId],
      });
    }
  }

  // --- Rule 4: concentration (warning) ----------------------------------
  const windowTotals = projects
    .map((p) => ({ project: p, total: windowSum(p, lastFull) }))
    .filter((t) => t.total > 0);
  if (windowTotals.length > 1) {
    const grandTotal = windowTotals.reduce((sum, t) => sum + t.total, 0);
    const leader = windowTotals.reduce((a, b) => (b.total > a.total ? b : a));
    const share = leader.total / grandTotal;
    if (grandTotal > 0 && share > CONCENTRATION_SHARE) {
      out.push({
        rule: 'concentration',
        severity: 'warning',
        message:
          `${Math.round(share * 100)}% of your income over the last three months came from ` +
          `${leader.project.name}. That's a concentration risk — a slump there would hit hard.`,
        project_ids: [leader.project.projectId],
      });
    }
  }

  // Warnings first; stable within a severity so rule/insertion order is preserved (Array.sort is
  // stable in Node ≥ 12).
  return out.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

// ---------------------------------------------------------------------------
// Revenue helpers (all operate on the sparse 'YYYY-MM' → number map)
// ---------------------------------------------------------------------------

function revenueIn(project: SuggestionProject, monthKey: string): number {
  return project.revenueByMonth[monthKey] ?? 0;
}

// Sum of the WINDOW_MONTHS calendar months ending at (and including) `endKey`.
function windowSum(project: SuggestionProject, endKey: string): number {
  const end = monthIndex(endKey);
  let total = 0;
  for (let i = 0; i < WINDOW_MONTHS; i++) {
    total += revenueIn(project, monthKeyFromIndex(end - i));
  }
  return total;
}

// Windowed monthly-equivalent revenue: the windowed sum spread over the whole window length, so
// gaps count as zero-revenue months (matching "revenue over 3 months").
function windowedMonthly(project: SuggestionProject, endKey: string): number {
  return windowSum(project, endKey) / WINDOW_MONTHS;
}

function severityRank(severity: Suggestion['severity']): number {
  return severity === 'warning' ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Month arithmetic ('YYYY-MM' keys via an absolute month index; UTC-safe)
// ---------------------------------------------------------------------------

function monthIndex(monthKey: string): number {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7)); // 1–12
  return year * 12 + (month - 1);
}

function monthKeyFromIndex(index: number): string {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

// The last COMPLETE month before `asOf`'s month, e.g. '2026-07-08' → '2026-06'.
function lastFullMonth(asOf: string): string {
  const year = Number(asOf.slice(0, 4));
  const month = Number(asOf.slice(5, 7));
  return monthKeyFromIndex(year * 12 + (month - 1) - 1);
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

// Money to a whole base-currency unit with thousands separators: 4000 → "€4,000", or "4,000 SEK"
// when the code has no known symbol. Cents are dropped — these are at-a-glance callouts.
function money(value: number, currency: string): string {
  const rounded = Math.round(value);
  const digits = Math.abs(rounded).toLocaleString('en-US');
  const symbol = CURRENCY_SYMBOLS[currency];
  const body = symbol ? `${symbol}${digits}` : `${digits} ${currency}`;
  return rounded < 0 ? `-${body}` : body;
}

// A multiplier to one decimal place: 2.34 → "2.3".
function formatMultiple(ratio: number): string {
  return (Math.round(ratio * 10) / 10).toString();
}
