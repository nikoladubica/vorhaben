// Typed mood-stream API calls built on the shared `api` helper. The helper already handles
// credentials, JSON, and ApiError (with the 422 `fields` map) — see client/src/api.ts.
//
// Mood is a stream, not a field (§2.2): the project shows one current feeling, but every change is
// appended as a timestamped MoodEvent. Nested reads/creates live under /projects/:id/moods; the
// per-user "logged today?" check is the flat /moods/today path (see server/src/routes/moods.ts).

import { api } from '../api';
import type { Feeling, MoodEvent, MoodKind, Trend } from '../types';

// A project's stream, newest first. `limit` is clamped server-side (default 50, max 200).
export function listProjectMoods(projectId: number, limit?: number): Promise<MoodEvent[]> {
  const qs = limit !== undefined ? `?limit=${limit}` : '';
  return api.get<MoodEvent[]>(`/projects/${projectId}/moods${qs}`);
}

// Which flow logged a mood. Defaults to 'manual' at the API; the Weekly Close passes 'weekly_close'
// so the shared write path tags provenance without a parallel route. Keep in sync with the server's
// MOOD_SOURCES (server/src/domain/mood.ts).
export type MoodSource = 'manual' | 'nudge' | 'weekly_close';

// Log a mood change, optionally carrying a one-line "why" note and a source marker. `kind` names
// which question the answer belongs to (§2.2, ticket 26): `feeling` (default, so existing call
// sites compile unchanged) validates the value against the 6 writable FEELINGS; `trend` validates
// against the 5 TRENDS; `untouched` records the explicit "didn't touch it" answer and requires a
// null value. This is the note-carrying write path; a note always appends a new event, even inside
// the per-kind settling window. An empty/whitespace note is treated as no note by the server.
export function logProjectMood(
  projectId: number,
  value: Feeling | Trend | null,
  note?: string,
  source?: MoodSource,
  kind: MoodKind = 'feeling',
): Promise<MoodEvent> {
  const body: {
    value: Feeling | Trend | null;
    note?: string;
    source?: MoodSource;
    kind: MoodKind;
  } = { value, kind };
  if (note !== undefined) body.note = note;
  if (source !== undefined) body.source = source;
  return api.post<MoodEvent>(`/projects/${projectId}/moods`, body);
}

// What the user has logged today — feeds the daily nudge. `logged` is true when any live mood event
// exists today. Coverage is now per kind (ticket 26): `feelingProjectIds` / `trendProjectIds` name
// the projects with a feeling / trend answer today; `untouchedProjectIds` names those answered
// "didn't touch it" — an untouched answer covers BOTH questions. `projectIds` is the legacy
// feeling-covered set, kept for backward compatibility. The nudge treats a project as done only when
// both questions are covered (directly or via untouched). The `tz` param is a signed minute offset
// from UTC so "today" matches the user's wall clock rather than server time.
export interface MoodToday {
  logged: boolean;
  projectIds: number[];
  feelingProjectIds: number[];
  trendProjectIds: number[];
  untouchedProjectIds: number[];
}

export function getMoodToday(): Promise<MoodToday> {
  const tz = new Date().getTimezoneOffset() * -1;
  return api.get<MoodToday>(`/moods/today?tz=${tz}`);
}
