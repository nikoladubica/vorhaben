// Typed mood-stream API calls built on the shared `api` helper. The helper already handles
// credentials, JSON, and ApiError (with the 422 `fields` map) — see client/src/api.ts.
//
// Mood is a stream, not a field (§2.2): the project shows one current feeling, but every change is
// appended as a timestamped MoodEvent. Nested reads/creates live under /projects/:id/moods; the
// per-user "logged today?" check is the flat /moods/today path (see server/src/routes/moods.ts).

import { api } from '../api';
import type { Feeling, MoodEvent } from '../types';

// A project's stream, newest first. `limit` is clamped server-side (default 50, max 200).
export function listProjectMoods(projectId: number, limit?: number): Promise<MoodEvent[]> {
  const qs = limit !== undefined ? `?limit=${limit}` : '';
  return api.get<MoodEvent[]>(`/projects/${projectId}/moods${qs}`);
}

// Log a mood change, optionally carrying a one-line "why" note. This is the note-carrying write
// path (source 'manual'); a note always appends a new event, even inside the settling window. An
// empty/whitespace note is treated as no note by the server.
export function logProjectMood(
  projectId: number,
  value: Feeling | null,
  note?: string,
): Promise<MoodEvent> {
  const body: { value: Feeling | null; note?: string } = { value };
  if (note !== undefined) body.note = note;
  return api.post<MoodEvent>(`/projects/${projectId}/moods`, body);
}

// Whether ANY live mood event exists today for the user — feeds the daily nudge (which shows only
// when `logged` is false). The `tz` param is a signed minute offset from UTC so "today" matches the
// user's wall clock rather than server time.
export function getMoodToday(): Promise<{ logged: boolean }> {
  const tz = new Date().getTimezoneOffset() * -1;
  return api.get<{ logged: boolean }>(`/moods/today?tz=${tz}`);
}
