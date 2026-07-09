import { db } from '../db/index.js';
import { convert, loadRates } from './fx.js';
import { ensureExpectedEntries, isSalaried } from './expectedEntries.js';
import {
  computeProjectMetrics,
  type MetricsEntry,
  type MetricsProject,
  type MetricsTimeLog,
  type ProjectMetrics,
} from './normalization.js';
import type { CompensationModel } from './constants.js';

// ---------------------------------------------------------------------------
// Metrics loader — the single DB-facing entry point for §2.2 normalization
// ---------------------------------------------------------------------------
//
// This is the thin adapter between the database and the pure normalization engine. It reads a
// user's projects, entries and time logs with a BOUNDED number of queries (five, regardless of
// project count: projects, all entries, all time logs, fx rates, user), converts each entry to
// the user's base currency via fx.ts, then hands the fully-materialized fixtures to
// computeProjectMetrics(). Tickets 09 (API) and 10 (dashboard) call this and nothing lower.
//
// One extra pass precedes those five queries: for SALARIED projects only (typically a handful),
// ensureExpectedEntries lazily materializes any missing expected entries so their revenue shows
// up here without a scheduler (BUSINESS_LOGIC.md §2.1). Non-salaried projects add no query.
//
// Query strategy: entries and time logs are loaded for the whole project set in ONE grouped
// query each (whereIn project ids), with NO date filter. The `fixed` model needs every one of
// its entries (full-duration amortization), and letting the pure layer apply the trailing
// window keeps all date logic in the tested module — so we load everything and window in memory.
// This is bounded by query COUNT, which is the acceptance criterion, not by row volume.

// Row shapes as returned by the selects below. Dates are DATE_FORMAT'd to 'YYYY-MM-DD' strings
// and decimals arrive as strings from mysql2 (matching routes/incomeEntries.ts conventions).
interface ProjectRow {
  id: number;
  compensation_model: CompensationModel;
  start_date: string;
  end_date: string | null;
}

interface EntryRow {
  project_id: number;
  date: string;
  amount: string;
  currency: string;
}

interface TimeLogRow {
  project_id: number;
  date: string;
  hours: string;
}

/**
 * Compute {@link ProjectMetrics} for every non-deleted project owned by `userId`.
 *
 * @param userId  the owner; every table is scoped by it (ownership of entries/logs flows through
 *                the project's user_id).
 * @param window  optional explicit trailing window; defaults to the trailing 3 calendar months
 *                ending today, per project (shortened for young projects) inside the pure layer.
 * @returns a Map from project id to its metrics. Projects with no data still get an entry (with
 *          null revenue/rate) so callers can list every project.
 */
export async function computeMetricsForUser(
  userId: number,
  window?: { from: string; to: string },
): Promise<Map<number, ProjectMetrics>> {
  // 1. Projects (scoped by user, soft-deleted excluded). end_date DATE_FORMATs to null cleanly.
  const projects = await db('projects')
    .where('user_id', userId)
    .whereNull('deleted_at')
    .select<ProjectRow[]>(
      'id',
      'compensation_model',
      db.raw("DATE_FORMAT(start_date, '%Y-%m-%d') as start_date"),
      db.raw("DATE_FORMAT(end_date, '%Y-%m-%d') as end_date"),
    );

  // 2. Base currency (defaults to EUR if the user row is somehow missing).
  const user = await db('users').where('id', userId).first('base_currency');
  const baseCurrency = (user as { base_currency: string } | undefined)?.base_currency ?? 'EUR';

  const result = new Map<number, ProjectMetrics>();
  if (projects.length === 0) return result;

  // Pre-generate expected entries for salaried projects (a no-op for the rest) BEFORE the bulk
  // entry query below picks them up — no special revenue branch in the math is needed.
  for (const project of projects) {
    if (isSalaried(project.compensation_model)) {
      await ensureExpectedEntries(project.id);
    }
  }

  const projectIds = projects.map((p) => p.id);

  // 3 & 4. All entries and all time logs for the project set — one grouped query each, no date
  // filter (see query-strategy note above).
  const entryRows = await db('income_entries')
    .whereIn('project_id', projectIds)
    .select<EntryRow[]>(
      'project_id',
      db.raw("DATE_FORMAT(date, '%Y-%m-%d') as date"),
      'amount',
      'currency',
    );

  const timeLogRows = await db('time_logs')
    .whereIn('project_id', projectIds)
    .select<TimeLogRow[]>('project_id', db.raw("DATE_FORMAT(date, '%Y-%m-%d') as date"), 'hours');

  // 5. FX rates for the base currency, loaded once for all conversions.
  const rates = await loadRates(baseCurrency);

  // Group entries by project, converting each at its own date. fx.ts returns fixed-2dp strings;
  // we take them to Number here (display metrics, not stored money — see normalization.ts note).
  const entriesByProject = new Map<number, MetricsEntry[]>();
  for (const row of entryRows) {
    const conversion = convert(row.amount, row.currency, baseCurrency, row.date, rates);
    pushToGroup(entriesByProject, row.project_id, {
      date: row.date,
      converted: Number(conversion.converted),
      missingRate: conversion.missing_rate,
    });
  }

  const logsByProject = new Map<number, MetricsTimeLog[]>();
  for (const row of timeLogRows) {
    pushToGroup(logsByProject, row.project_id, {
      date: row.date,
      hours: Number(row.hours),
    });
  }

  const asOf = todayUtc();

  for (const project of projects) {
    const projectInput: MetricsProject = {
      compensationModel: project.compensation_model,
      startDate: project.start_date,
      endDate: project.end_date,
    };
    result.set(
      project.id,
      computeProjectMetrics(
        projectInput,
        entriesByProject.get(project.id) ?? [],
        logsByProject.get(project.id) ?? [],
        { asOf, window },
      ),
    );
  }

  return result;
}

function pushToGroup<T>(map: Map<number, T[]>, key: number, value: T): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

// Reference "today" as a 'YYYY-MM-DD' string in UTC — matches how DATE columns are compared.
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
