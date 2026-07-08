import { db } from '../db/index.js';
import { convert, loadRates } from './fx.js';
import { computeMetricsForUser } from './metrics.js';
import { buildSuggestions, type Suggestion, type SuggestionProject } from './suggestions.js';

// ---------------------------------------------------------------------------
// Dashboard aggregation (BUSINESS_LOGIC.md §4.1) — the read model behind GET /api/dashboard
// ---------------------------------------------------------------------------
//
// This module assembles everything the dashboard renders EXCEPT the focus suggestion (ticket 10):
// the two best-performer rankings, the stacked monthly trend, the income-by-type composition, the
// project timeline, and the missing-rate warnings.
//
// Two deliberate reads of the same data. The rankings come from computeMetricsForUser() — the
// canonical trailing-3-month normalization window (metrics.ts is the single normalization entry
// point; we never call the pure layer directly). But that function only returns the two headline
// figures per project; it does NOT expose the per-month / per-type / per-currency detail the
// trend, composition and warnings need. So buildDashboard runs a SECOND, dedicated pass over the
// user's entries — one income_entries query (joined to projects for `type`, user-scoped,
// non-deleted, date within the trend range), one loadRates(base), and one convert() per entry.
// This second read is intentional and uncached: the two consumers have genuinely different
// windows (rankings = fixed trailing 3 months; trend/composition = the caller's N-month horizon)
// and different granularity, and keeping them separate keeps each simple. Row volume per user is
// small; the cost is a handful of extra queries, not a hot path.
//
// The `months` parameter governs ONLY the trend / composition / timeline horizon. It never
// widens or narrows the ranking window — rankings are always the canonical trailing quarter.

// ---------------------------------------------------------------------------
// Response shapes (the exact JSON contract consumed by the client)
// ---------------------------------------------------------------------------

export interface RankedProject {
  project_id: number;
  name: string;
  type: string;
  status: string;
  monthly_revenue: number | null;
  effective_hourly_rate: number | null;
  hours_in_window: number;
}

export interface TrendSeries {
  project_id: number;
  name: string;
  values: number[]; // aligned 1:1 with trend.months, zero-filled
}

export interface CompositionSlice {
  type: string;
  label: string;
  share: number; // 0–1 fraction of grand total, 4 dp
  total: number; // converted base-currency total, 2 dp
}

export interface TimelineProject {
  project_id: number;
  name: string;
  status: string;
  start_date: string; // 'YYYY-MM-DD'
  end_date: string | null; // 'YYYY-MM-DD' or null when ongoing
}

export interface Dashboard {
  base_currency: string;
  rankings: {
    by_monthly_revenue: RankedProject[];
    by_hourly_rate: RankedProject[];
  };
  trend: {
    months: string[]; // ['2026-02', …] length === options.months
    series: TrendSeries[];
  };
  composition: CompositionSlice[];
  timeline: TimelineProject[];
  warnings: {
    missing_rates: string[]; // sorted unique currency codes with no usable fx rate
  };
}

export interface DashboardOptions {
  months?: number; // trend/composition/timeline horizon; validated by the route (1–36)
}

// ---------------------------------------------------------------------------
// DB row shapes (dates DATE_FORMAT'd to 'YYYY-MM-DD'; decimals arrive as strings from mysql2)
// ---------------------------------------------------------------------------

interface ProjectMetaRow {
  id: number;
  name: string;
  type: string;
  status: string;
  start_date: string;
  end_date: string | null;
}

interface EntryRow {
  project_id: number;
  date: string;
  amount: string;
  currency: string;
}

interface TypeRow {
  id: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Rounding — done ONCE at this edge (per ticket 07): the normalization layer keeps full
// precision, the API rounds for display. null passes through untouched.
// ---------------------------------------------------------------------------

function roundMoney(value: number | null): number | null {
  if (value === null) return null;
  return Math.round(value * 100) / 100;
}

function roundShare(value: number): number {
  return Math.round(value * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Date helpers ('YYYY-MM-DD' / 'YYYY-MM' strings; UTC-anchored, no Date drift)
// ---------------------------------------------------------------------------

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// The N month keys ending at `asOf`'s month, oldest first: e.g. (2026-07-08, 6) →
// ['2026-02','2026-03','2026-04','2026-05','2026-06','2026-07'].
function monthKeysEndingAt(asOf: string, count: number): string[] {
  const year = Number(asOf.slice(0, 4));
  const month = Number(asOf.slice(5, 7)); // 1–12
  const endIndex = year * 12 + (month - 1); // absolute 0-based month index
  const keys: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const idx = endIndex - i;
    const y = Math.floor(idx / 12);
    const m = (idx % 12) + 1;
    keys.push(`${y}-${pad2(m)}`);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Build the full dashboard read model for `userId`.
 *
 * @param userId  the owner; every query is scoped by it and soft-deleted projects are excluded.
 * @param options `months` = the trend/composition/timeline horizon (default 6). Rankings ignore
 *                it and always use the canonical trailing-3-month window from metrics.ts.
 */
export async function buildDashboard(
  userId: number,
  options: DashboardOptions = {},
): Promise<Dashboard> {
  const months = options.months ?? 6;

  // 1. Base currency + reference date.
  const user = await db('users').where('id', userId).first('base_currency');
  const baseCurrency = (user as { base_currency: string } | undefined)?.base_currency ?? 'EUR';
  const asOf = todayUtc();

  // 2. Month keys + the trend range [rangeStart, asOf].
  const monthKeys = monthKeysEndingAt(asOf, months);
  const rangeStart = `${monthKeys[0]}-01`;
  const monthIndex = new Map(monthKeys.map((key, i) => [key, i]));

  // 3. Non-deleted project metadata — reused for the ranking join AND the timeline.
  const projectMeta = await db('projects')
    .where('user_id', userId)
    .whereNull('deleted_at')
    .select<ProjectMetaRow[]>(
      'id',
      'name',
      'type',
      'status',
      db.raw("DATE_FORMAT(start_date, '%Y-%m-%d') as start_date"),
      db.raw("DATE_FORMAT(end_date, '%Y-%m-%d') as end_date"),
    );
  const metaById = new Map(projectMeta.map((p) => [p.id, p]));

  // 4. Rankings — canonical trailing-window metrics joined to metadata. Only active/paused
  //    projects rank (ended & idea are excluded; ended still appears in trend/timeline).
  const metrics = await computeMetricsForUser(userId);
  const ranked: RankedProject[] = [];
  for (const meta of projectMeta) {
    if (meta.status !== 'active' && meta.status !== 'paused') continue;
    const m = metrics.get(meta.id);
    ranked.push({
      project_id: meta.id,
      name: meta.name,
      type: meta.type,
      status: meta.status,
      monthly_revenue: roundMoney(m?.monthlyRevenue ?? null),
      effective_hourly_rate: roundMoney(m?.effectiveHourlyRate ?? null),
      hours_in_window: m?.hoursInWindow ?? 0,
    });
  }

  // Two independent rankings, never a blended score.
  // by_monthly_revenue: descending, nulls last (a project with no revenue still lists).
  const byMonthlyRevenue = [...ranked].sort((a, b) => {
    if (a.monthly_revenue === null && b.monthly_revenue === null) return 0;
    if (a.monthly_revenue === null) return 1;
    if (b.monthly_revenue === null) return -1;
    return b.monthly_revenue - a.monthly_revenue;
  });
  // by_hourly_rate: descending; projects with a null rate are EXCLUDED entirely.
  const byHourlyRate = ranked
    .filter((r) => r.effective_hourly_rate !== null)
    .sort((a, b) => (b.effective_hourly_rate as number) - (a.effective_hourly_rate as number));

  // 5. Second pass over entries in the trend range (see module note).
  const entryRows =
    projectMeta.length === 0
      ? []
      : await db('income_entries as e')
          .join('projects as p', 'p.id', 'e.project_id')
          .where('p.user_id', userId)
          .whereNull('p.deleted_at')
          .andWhere('e.date', '>=', rangeStart)
          .andWhere('e.date', '<=', asOf)
          .select<EntryRow[]>(
            'e.project_id as project_id',
            db.raw("DATE_FORMAT(e.date, '%Y-%m-%d') as date"),
            'e.amount as amount',
            'e.currency as currency',
          );

  const rates = await loadRates(baseCurrency);

  // Accumulators for trend (per project → per month), composition (per type) and warnings.
  const trendByProject = new Map<number, number[]>();
  const totalByType = new Map<string, number>();
  const missingCurrencies = new Set<string>();
  let grandTotal = 0;

  for (const row of entryRows) {
    const conversion = convert(row.amount, row.currency, baseCurrency, row.date, rates);
    if (conversion.missing_rate) missingCurrencies.add(row.currency);
    const value = Number(conversion.converted);

    // Trend: zero-filled array aligned to monthKeys, one per project with ≥1 entry in range.
    const key = row.date.slice(0, 7);
    const idx = monthIndex.get(key);
    if (idx !== undefined) {
      let series = trendByProject.get(row.project_id);
      if (!series) {
        series = new Array(monthKeys.length).fill(0);
        trendByProject.set(row.project_id, series);
      }
      series[idx] = (series[idx] ?? 0) + value;
    }

    // Composition: grouped by the project's type.
    const type = metaById.get(row.project_id)?.type;
    if (type !== undefined) {
      totalByType.set(type, (totalByType.get(type) ?? 0) + value);
      grandTotal += value;
    }
  }

  // Trend series in stable metadata order (only projects with entries in range).
  const series: TrendSeries[] = [];
  for (const meta of projectMeta) {
    const values = trendByProject.get(meta.id);
    if (!values) continue;
    series.push({
      project_id: meta.id,
      name: meta.name,
      values: values.map((v) => roundMoney(v) as number),
    });
  }

  // Composition: shares of the grand total. Empty when there was no income at all.
  let composition: CompositionSlice[] = [];
  if (grandTotal !== 0 && totalByType.size > 0) {
    const typeRows = await db('project_types').select<TypeRow[]>('id', 'label');
    const labelById = new Map(typeRows.map((t) => [t.id, t.label]));
    composition = [...totalByType.entries()]
      .map(([type, total]) => ({
        type,
        label: labelById.get(type) ?? type,
        share: roundShare(total / grandTotal),
        total: roundMoney(total) as number,
      }))
      // Largest share first; type as a stable tiebreak.
      .sort((a, b) => b.total - a.total || a.type.localeCompare(b.type));
  }

  // 6. Timeline: all non-deleted projects whose lifespan overlaps the trend range. Raw dates.
  const timeline: TimelineProject[] = projectMeta
    .filter(
      (p) => p.start_date <= asOf && (p.end_date === null || p.end_date >= rangeStart),
    )
    .map((p) => ({
      project_id: p.id,
      name: p.name,
      status: p.status,
      start_date: p.start_date,
      end_date: p.end_date,
    }));

  return {
    base_currency: baseCurrency,
    rankings: {
      by_monthly_revenue: byMonthlyRevenue,
      by_hourly_rate: byHourlyRate,
    },
    trend: {
      months: monthKeys,
      series,
    },
    composition,
    timeline,
    warnings: {
      missing_rates: [...missingCurrencies].sort(),
    },
  };
}

// ---------------------------------------------------------------------------
// Focus suggestions (BUSINESS_LOGIC.md §4.2) — DB-facing assembler
// ---------------------------------------------------------------------------
//
// This is the thin adapter between the database and the PURE rules in domain/suggestions.ts. It
// is deliberately a SEPARATE payload from buildDashboard (per ticket 10): the client loads the
// callout independently, and the future LLM variant can swap in behind the identical
// Suggestion[] shape without touching the rest of the dashboard.
//
// It reuses the canonical normalization once (computeMetricsForUser → the windowed effective
// hourly rate that rule 1 ranks on) and adds ONE second pass over the user's income entries —
// the same pattern buildDashboard uses — to bucket converted revenue per project per calendar
// month, which powers the trend-based rules 2, 3 and 4. No date filter on that pass: an ended
// project's own last-active-quarter (rule 3) may sit well before any fixed trailing window.

/**
 * Assemble and run the four v1 focus heuristics for `userId`.
 *
 * @param userId  the owner; every query is user-scoped and soft-deleted projects are excluded.
 * @returns the fired suggestions, warnings first (an empty array is a valid, common result).
 */
export async function buildSuggestionsForUser(userId: number): Promise<Suggestion[]> {
  // 1. Base currency + reference date.
  const user = await db('users').where('id', userId).first('base_currency');
  const baseCurrency = (user as { base_currency: string } | undefined)?.base_currency ?? 'EUR';
  const asOf = todayUtc();

  // 2. Non-deleted project metadata (name/status/end_date drive the rules; type unused here).
  const projectMeta = await db('projects')
    .where('user_id', userId)
    .whereNull('deleted_at')
    .select<ProjectMetaRow[]>(
      'id',
      'name',
      'type',
      'status',
      db.raw("DATE_FORMAT(start_date, '%Y-%m-%d') as start_date"),
      db.raw("DATE_FORMAT(end_date, '%Y-%m-%d') as end_date"),
    );
  if (projectMeta.length === 0) return [];

  // 3. Canonical windowed metrics — reused once for the effective hourly rate (rule 1).
  const metrics = await computeMetricsForUser(userId);

  // 4. Every income entry for the user's projects (no date filter), converted and bucketed per
  //    project per calendar month.
  const entryRows = await db('income_entries as e')
    .join('projects as p', 'p.id', 'e.project_id')
    .where('p.user_id', userId)
    .whereNull('p.deleted_at')
    .select<EntryRow[]>(
      'e.project_id as project_id',
      db.raw("DATE_FORMAT(e.date, '%Y-%m-%d') as date"),
      'e.amount as amount',
      'e.currency as currency',
    );

  const rates = await loadRates(baseCurrency);

  const revenueByProject = new Map<number, Record<string, number>>();
  for (const row of entryRows) {
    const conversion = convert(row.amount, row.currency, baseCurrency, row.date, rates);
    const value = Number(conversion.converted);
    const monthKey = row.date.slice(0, 7);
    let byMonth = revenueByProject.get(row.project_id);
    if (!byMonth) {
      byMonth = {};
      revenueByProject.set(row.project_id, byMonth);
    }
    byMonth[monthKey] = (byMonth[monthKey] ?? 0) + value;
  }

  // 5. Materialize the per-project records and hand them to the pure rules.
  const suggestionProjects: SuggestionProject[] = projectMeta.map((meta) => ({
    projectId: meta.id,
    name: meta.name,
    status: meta.status,
    effectiveHourlyRate: metrics.get(meta.id)?.effectiveHourlyRate ?? null,
    endMonth: meta.end_date === null ? null : meta.end_date.slice(0, 7),
    revenueByMonth: revenueByProject.get(meta.id) ?? {},
  }));

  return buildSuggestions(suggestionProjects, asOf, baseCurrency);
}
