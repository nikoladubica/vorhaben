// Typed time-log API calls built on the shared `api` helper. The helper already handles
// credentials, JSON, and ApiError (with the 422 `fields` map) — see client/src/api.ts.
//
// Nested reads/creates live under /projects/:id/time-logs; single-log PATCH/DELETE use the flat
// /time-logs/:id paths (see server/src/routes/timeLogs.ts). `hours` stays a string end to end so
// "7.5" round-trips exactly through the decimal column.

import { api } from '../api';
import type { TimeLog, TimeLogInput } from '../types';

export interface TimeLogRange {
  from?: string;
  to?: string;
}

// Build the ?from=&to= querystring, omitting empty values (mirrors projects.ts buildQuery).
function buildQuery(range: TimeLogRange): string {
  const params = new URLSearchParams();
  if (range.from) params.set('from', range.from);
  if (range.to) params.set('to', range.to);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function listTimeLogs(
  projectId: number,
  range: TimeLogRange = {},
): Promise<TimeLog[]> {
  return api.get<TimeLog[]>(`/projects/${projectId}/time-logs${buildQuery(range)}`);
}

export function createTimeLog(
  projectId: number,
  input: TimeLogInput,
): Promise<TimeLog> {
  return api.post<TimeLog>(`/projects/${projectId}/time-logs`, input);
}

export function updateTimeLog(
  id: number,
  input: Partial<TimeLogInput>,
): Promise<TimeLog> {
  return api.patch<TimeLog>(`/time-logs/${id}`, input);
}

export function deleteTimeLog(id: number): Promise<void> {
  return api.del<void>(`/time-logs/${id}`);
}
