import { Router } from 'express';
import { db } from '../db/index.js';
import { convert, loadRates } from '../domain/fx.js';

// Mounted at /api/closes behind requireAuth (see app.ts). Owns the Weekly Close ritual
// (breaktrough.md §2.5): the banner/page read-model, the idempotent completion write, and the
// close-day preference. Every query is scoped by req.userId (never a body-supplied id) and is
// soft-delete aware.
export const closesRouter = Router();

// ---------------------------------------------------------------------------
// Time-zone handling (mirrors routes/moods.ts)
// ---------------------------------------------------------------------------

// `tz` is an optional signed minute offset from UTC (e.g. 120 for UTC+2) so "today" / "this week"
// match the user's wall clock; omitted → server time. Clamped to a real-world range.
const MAX_TZ_OFFSET = 14 * 60; // +14:00, the largest real offset

function parseTzOffset(raw: unknown): number {
  if (typeof raw !== 'string' || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n)) return 0;
  return Math.max(-MAX_TZ_OFFSET, Math.min(MAX_TZ_OFFSET, n));
}

// ---------------------------------------------------------------------------
// ISO-8601 week helpers (Monday-start weeks; week 1 contains the year's first Thursday)
// ---------------------------------------------------------------------------

const PERIOD_RE = /^\d{4}-W\d{2}$/;
const MS_PER_WEEK = 7 * 86_400_000;

interface WeekInfo {
  period: string; // "YYYY-Www", zero-padded
  start: string; // 'YYYY-MM-DD' — first day of the user's week (Monday or Sunday per week_start)
  end: string; // 'YYYY-MM-DD' — last day of the user's week
  weekday: number; // reference day's weekday, 0 = Sunday … 6 = Saturday (matches close_day)
}

// Format a Date's UTC calendar day as 'YYYY-MM-DD'.
function ymd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Derive the user's week that `wall` falls in, plus that week's first/last day bounds. `wall` is a
 * Date whose UTC components equal the user's wall-clock date/time (built by shifting NOW() by the
 * tz offset), so all calendar math here uses the UTC getters and stays DST-free.
 *
 * `weekStart` is the user's first day of week (0 = Sunday, 1 = Monday). The window bounds shift
 * with it, but the `"YYYY-Www"` period key stays anchored on the Monday inside the window, so the
 * key format is unchanged and Monday-start (weekStart = 1) output is byte-for-byte identical to the
 * previous ISO-8601-only implementation.
 */
function isoWeekInfo(wall: Date, weekStart: number): WeekInfo {
  // Weekday for the close-day comparison uses the wall clock directly (0 = Sun … 6 = Sat).
  const weekday = wall.getUTCDay();
  // Pure-date copy at UTC midnight.
  const date = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate()));
  // Position of `date` within the user's week: 0 = first day … 6 = last day.
  const dow = (date.getUTCDay() - weekStart + 7) % 7;

  // First and last day of the user's week.
  const start = new Date(date);
  start.setUTCDate(date.getUTCDate() - dow);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);

  // The Monday inside this window uniquely identifies an ISO-8601 week and anchors the period key
  // (unchanged format). For a Monday-start week that Monday is the window's start day; for a
  // Sunday-start week it is start + 1 day.
  const monday = new Date(start);
  if (weekStart === 0) monday.setUTCDate(start.getUTCDate() + 1);

  // The Thursday of the ISO week decides the ISO year (and thus which year's week 1 to count from).
  const thursday = new Date(monday);
  thursday.setUTCDate(monday.getUTCDate() + 3);
  const isoYear = thursday.getUTCFullYear();

  // Week 1 is the week containing Jan 4 (equivalently the year's first Thursday). Count whole
  // weeks between this ISO week's Monday and week 1's Monday.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Dow);
  const week = 1 + Math.round((monday.getTime() - week1Monday.getTime()) / MS_PER_WEEK);

  return {
    period: `${isoYear}-W${String(week).padStart(2, '0')}`,
    start: ymd(start),
    end: ymd(end),
    weekday,
  };
}

// ---------------------------------------------------------------------------
// Fixed-point money summing (kept in integer cents; no float drift on the sum)
// ---------------------------------------------------------------------------

// fx.convert returns a fixed-2-decimal string ("240.00"); take it to integer cents. The round
// guards any stray binary-float representation before it enters the running total.
function moneyToCents(fixed2: string): number {
  return Math.round(Number(fixed2) * 100);
}

// Format integer cents back to a fixed-2-decimal string ("0.00", "240.00").
function centsToFixed(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

// ---------------------------------------------------------------------------
// GET /api/closes/current — the state the banner + Close page need
// ---------------------------------------------------------------------------

interface CurrentProject {
  project_id: number;
  name: string;
  hours: string; // total hours logged this week (decimal string; "0.0" when none)
  income: string; // income entered this week, converted to base currency ("0.00" when none)
  mood_events: number; // count of live mood events this week for the project
}

interface CurrentResponse {
  period: string;
  closed: boolean;
  close_day: number;
  week_start: number;
  in_window: boolean;
  base_currency: string;
  projects: CurrentProject[];
}

closesRouter.get('/current', async (req, res) => {
  const userId = req.userId as number;
  const tz = parseTzOffset(req.query.tz);

  // User row: base currency (for conversion) + close-day and week-start preferences.
  const user = await db('users')
    .where('id', userId)
    .first<{ base_currency: string; close_day: number; week_start: number } | undefined>(
      'base_currency',
      'close_day',
      'week_start',
    );
  const baseCurrency = user?.base_currency ?? 'EUR';
  const closeDay = Number(user?.close_day ?? 0);
  // 0 = Sunday, 1 = Monday. Anything else falls back to the Monday default.
  const weekStart = Number(user?.week_start) === 0 ? 0 : 1;

  // Resolve "now" in the user's wall clock, then the week it belongs to. "This week" is that week's
  // first-day..last-day date range, which shifts with week_start.
  const wall = new Date(Date.now() + tz * 60_000);
  const { period, start, end, weekday } = isoWeekInfo(wall, weekStart);

  // Is this week already closed? A live weekly_closes row for (user, period).
  const closeRow = await db('weekly_closes')
    .where({ user_id: userId, period })
    .whereNull('deleted_at')
    .first('id');
  const closed = !!closeRow;

  // The banner window is open once today has reached the close day within the user's week — but
  // never while the week is already closed. Both days are mapped to their position within the
  // user's week (0 = first day … 6 = last day) before comparing; comparing these positions rather
  // than raw Sunday-indexed numbers is what fixes the "banner opens every day" bug and makes the
  // gate correct for any week_start / close_day pairing.
  const currentPos = (weekday - weekStart + 7) % 7;
  const closePos = (closeDay - weekStart + 7) % 7;
  const inWindow = currentPos >= closePos && !closed;

  // Active, non-deleted projects only (paused/ended/idea are out of the walk, per §2.5), ordered
  // by name for a stable walk order.
  const projects = await db('projects')
    .where({ user_id: userId, status: 'active' })
    .whereNull('deleted_at')
    .orderBy('name', 'asc')
    .select<Array<{ id: number; name: string }>>('id', 'name');

  if (projects.length === 0) {
    const empty: CurrentResponse = {
      period,
      closed,
      close_day: closeDay,
      week_start: weekStart,
      in_window: inWindow,
      base_currency: baseCurrency,
      projects: [],
    };
    res.json(empty);
    return;
  }

  const projectIds = projects.map((p) => p.id);

  // Hours: v1 glance — a simple SUM of `hours` for logs whose `date` falls in the week (a
  // range-spanning log is counted by its start day only; matches how the metrics loader keeps
  // range handling out of the glance queries). One grouped query. Ownership flows through the
  // project set already scoped to this user above.
  const hourRows = await db('time_logs')
    .whereIn('project_id', projectIds)
    .andWhere('date', '>=', start)
    .andWhere('date', '<=', end)
    .groupBy('project_id')
    .select<Array<{ project_id: number; hours: string }>>(
      'project_id',
      db.raw('SUM(hours) as hours'),
    );
  const hoursByProject = new Map<number, string>();
  for (const row of hourRows) {
    // SUM over a DECIMAL column arrives as a string from mysql2; String() guards the type contract.
    hoursByProject.set(row.project_id, String(row.hours));
  }

  // Income: every entry in the week, converted to base currency at its own date and summed in
  // fixed-point cents (mirrors how the metrics/dashboard loaders convert per entry). One query +
  // one rate load.
  const incomeRows = await db('income_entries')
    .whereIn('project_id', projectIds)
    .andWhere('date', '>=', start)
    .andWhere('date', '<=', end)
    .select<Array<{ project_id: number; date: string; amount: string; currency: string }>>(
      'project_id',
      db.raw("DATE_FORMAT(date, '%Y-%m-%d') as date"),
      'amount',
      'currency',
    );
  const rates = await loadRates(baseCurrency);
  const incomeCentsByProject = new Map<number, number>();
  for (const row of incomeRows) {
    const { converted } = convert(row.amount, row.currency, baseCurrency, row.date, rates);
    const prev = incomeCentsByProject.get(row.project_id) ?? 0;
    incomeCentsByProject.set(row.project_id, prev + moneyToCents(converted));
  }

  // Mood events this week: live events whose wall-clock created_at date (tz-shifted, same as
  // /moods/today) lands in the week. One grouped count. This is a check-in ACTIVITY count (did the
  // user address the project this week?), so ALL kinds count — a feeling, a trend, or an explicit
  // "didn't touch it" all mean the project was addressed (ticket 26). No kind filter on purpose.
  const moodRows = await db('mood_events')
    .where('user_id', userId)
    .whereIn('project_id', projectIds)
    .whereNull('deleted_at')
    .whereRaw('DATE(created_at + INTERVAL ? MINUTE) BETWEEN ? AND ?', [tz, start, end])
    .groupBy('project_id')
    .select<Array<{ project_id: number; c: number }>>('project_id', db.raw('COUNT(*) as c'));
  const moodByProject = new Map<number, number>();
  for (const row of moodRows) {
    moodByProject.set(row.project_id, Number(row.c));
  }

  const projectSummaries: CurrentProject[] = projects.map((p) => ({
    project_id: p.id,
    name: p.name,
    hours: hoursByProject.get(p.id) ?? '0.0',
    income: centsToFixed(incomeCentsByProject.get(p.id) ?? 0),
    mood_events: moodByProject.get(p.id) ?? 0,
  }));

  const response: CurrentResponse = {
    period,
    closed,
    close_day: closeDay,
    week_start: weekStart,
    in_window: inWindow,
    base_currency: baseCurrency,
    projects: projectSummaries,
  };
  res.json(response);
});

// ---------------------------------------------------------------------------
// POST /api/closes — record (or re-record) a week's completion. Idempotent.
// ---------------------------------------------------------------------------

interface CloseRow {
  id: number;
  period: string;
  completed_at: Date;
}

closesRouter.post('/', async (req, res) => {
  const userId = req.userId as number;
  const body = (req.body ?? {}) as { period?: unknown };

  // period: required, ISO-week shaped ("YYYY-Www"). The user_id is always the caller's — never
  // taken from the body.
  if (typeof body.period !== 'string' || !PERIOD_RE.test(body.period)) {
    res.status(422).json({ error: 'validation', fields: { period: 'invalid' } });
    return;
  }
  const period = body.period;

  // Upsert the single (user_id, period) row: revive a soft-deleted row, refresh a live one, or
  // insert a new one. Existing (live or revived) → 200; brand-new → 201.
  const existing = await db('weekly_closes')
    .where({ user_id: userId, period })
    .first<{ id: number; deleted_at: Date | null } | undefined>('id', 'deleted_at');

  let status: 200 | 201;
  let rowId: number;
  if (!existing) {
    const [id] = await db('weekly_closes').insert({
      user_id: userId,
      period,
      completed_at: db.fn.now(),
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
    rowId = Number(id);
    status = 201;
  } else {
    // Live row → refresh completed_at; soft-deleted row → revive it (clear deleted_at). Either way
    // the same single row lives on, so the unique constraint is never challenged.
    await db('weekly_closes')
      .where('id', existing.id)
      .update({ completed_at: db.fn.now(), updated_at: db.fn.now(), deleted_at: null });
    rowId = existing.id;
    status = 200;
  }

  const row = await db('weekly_closes')
    .where('id', rowId)
    .first<CloseRow | undefined>('id', 'period', 'completed_at');
  res.status(status).json(row);
});

// ---------------------------------------------------------------------------
// PATCH /api/closes/settings — persist the close-day preference
// ---------------------------------------------------------------------------
//
// Kept on closesRouter (not account.ts) so the account PATCH stays a currency-only contract. The
// id is always req.userId.
closesRouter.patch('/settings', async (req, res) => {
  const userId = req.userId as number;
  const body = (req.body ?? {}) as { close_day?: unknown; week_start?: unknown };

  // close_day: required integer 0-6 (0 = Sunday … 6 = Saturday).
  if (
    typeof body.close_day !== 'number' ||
    !Number.isInteger(body.close_day) ||
    body.close_day < 0 ||
    body.close_day > 6
  ) {
    res.status(422).json({ error: 'validation', fields: { close_day: 'invalid' } });
    return;
  }
  const closeDay = body.close_day;

  // week_start: optional, but when present must be exactly 0 (Sunday) or 1 (Monday). It is stored
  // as-is and never auto-mutates close_day (they are independent preferences).
  let weekStart: number | undefined;
  if (body.week_start !== undefined) {
    if (body.week_start !== 0 && body.week_start !== 1) {
      res.status(422).json({ error: 'validation', fields: { week_start: 'invalid' } });
      return;
    }
    weekStart = body.week_start;
  }

  const patch: { close_day: number; week_start?: number } = { close_day: closeDay };
  if (weekStart !== undefined) patch.week_start = weekStart;

  await db('users').where('id', userId).update(patch);
  res.json(patch);
});
