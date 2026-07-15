// Typed Worth-It Matrix call built on the shared `api` helper (credentials, JSON, and ApiError are
// handled there — see client/src/api.ts). The interface below mirrors the server response shape
// exactly (server/src/domain/matrix.ts); field names stay snake_case as the API delivers them.
//
// The signature quadrant screen (breaktrough.md §2.6): effective hourly rate (X) crossed with the
// feeling trend (Y), dot size by monthly hours. Unlike GET /api/signals, this endpoint returns
// EVERY active project — the client decides plottability (rate present AND confidence !== 'none')
// and lists the rest honestly below the chart. `trend_score` stays internal; the axis never shows
// a number.

import { api } from '../api';

// One active project's matrix row. `effective_hourly_rate` is null when no hours were logged, and
// `trend_score` is null when confidence is 'none' (fewer than 3 days of mood data) — either makes
// the project unplottable. `sentence` is the render-ready First Signal, or null when there is
// nothing describable yet.
export interface MatrixProject {
  project_id: number;
  name: string;
  effective_hourly_rate: number | null;
  monthly_hours: number;
  trend_score: number | null;
  confidence: 'none' | 'early' | 'pattern' | 'established';
  swing: 'none' | 'mild' | 'harsh';
  sentence: string | null;
}

// GET /api/matrix payload. `median_rate` is the X quadrant boundary — the portfolio median rate
// over plottable projects only ("pays well for you") — and is null when nothing is plottable.
export interface MatrixPayload {
  base_currency: string;
  median_rate: number | null;
  projects: MatrixProject[];
}

// GET /api/matrix — the assembled matrix for the caller's active projects (an empty projects array
// is a valid, common result for a fresh account).
export function getMatrix(): Promise<MatrixPayload> {
  return api.get<MatrixPayload>('/matrix');
}
