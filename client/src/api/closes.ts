// Typed Weekly Close API calls built on the shared `api` helper (credentials, JSON, and ApiError
// with the `fields` map are handled there — see client/src/api.ts). The interfaces mirror the
// server response shapes exactly (server/src/routes/closes.ts); field names stay snake_case as the
// API delivers them.
//
// The Weekly Close ritual (breaktrough.md §2.5): a once-a-week guided walk of the active projects
// ending on a summary, whose completion is PERSISTED (not a localStorage flag) so the Quarterly
// Statement (ticket 07) can cite closes and drift alerts (ticket 06) can lean on close-to-close
// mood readings.

import { api } from '../api';

// One active project's week-at-a-glance, as returned inside GET /closes/current. `hours` is a
// decimal string ("12.5", "0.0" when none); `income` is a fixed-2 decimal string in the base
// currency ("240.00", "0.00" when none); `mood_events` counts this week's live mood events.
export interface CloseProject {
  project_id: number;
  name: string;
  hours: string;
  income: string;
  mood_events: number;
}

// The banner + Close-page state. `period` is the current ISO week ("2026-W28"); `closed` is whether
// a completion row exists for it; `close_day` is the user's preference (0 = Sunday … 6 = Saturday);
// `week_start` is the first day of the user's week (0 = Sunday, 1 = Monday), which defines the
// tracked week; `in_window` is whether today has reached the close day within that week AND the
// week is not yet closed (the banner shows during this window).
export interface CloseCurrent {
  period: string;
  closed: boolean;
  close_day: number;
  week_start: number;
  in_window: boolean;
  base_currency: string;
  projects: CloseProject[];
}

// The persisted completion row returned by POST /closes.
export interface WeeklyClose {
  id: number;
  period: string;
  completed_at: string;
}

// GET /api/closes/current — the state the banner and page need. `tz` is a signed minute offset from
// UTC so "this week" / "today" match the user's wall clock (same convention as /moods/today).
export function getCloseCurrent(): Promise<CloseCurrent> {
  const tz = new Date().getTimezoneOffset() * -1;
  return api.get<CloseCurrent>(`/closes/current?tz=${tz}`);
}

// POST /api/closes — record (or re-record) a week's completion. Idempotent: re-closing the same
// period revives/refreshes the single row rather than duplicating it.
export function recordClose(period: string): Promise<WeeklyClose> {
  return api.post<WeeklyClose>('/closes', { period });
}

// PATCH /api/closes/settings — persist the close-day preference (0 = Sunday … 6 = Saturday). A bad
// value yields a 422 ApiError with fields.close_day = 'invalid'.
export function updateCloseDay(closeDay: number): Promise<{ close_day: number }> {
  return api.patch<{ close_day: number }>('/closes/settings', { close_day: closeDay });
}

// PATCH /api/closes/settings — persist the first-day-of-week preference (0 = Sunday, 1 = Monday).
// The endpoint requires close_day too, so we send the current value alongside week_start. A bad
// value yields a 422 ApiError with fields.week_start = 'invalid'.
export function updateWeekStart(
  weekStart: number,
  closeDay: number,
): Promise<{ close_day: number; week_start: number }> {
  return api.patch<{ close_day: number; week_start: number }>('/closes/settings', {
    close_day: closeDay,
    week_start: weekStart,
  });
}
