// Typed dashboard + suggestions calls built on the shared `api` helper (credentials, JSON, and
// ApiError are handled there — see client/src/api.ts). The interfaces below mirror the server
// response shapes exactly (server/src/domain/dashboard.ts and domain/suggestions.ts); field names
// stay snake_case as the API delivers them.

import { api } from '../api';

// One ranked project row. Both rankings share this shape; `monthly_revenue` /
// `effective_hourly_rate` are null when the figure is unavailable (see the two sort rules on the
// server — the hourly ranking excludes null rates, the revenue ranking keeps them, nulls last).
export interface RankedProject {
  project_id: number;
  name: string;
  type: string;
  status: string;
  monthly_revenue: number | null;
  effective_hourly_rate: number | null;
  hours_in_window: number;
}

// One project's monthly trend series; `values` is aligned 1:1 with `trend.months` and zero-filled.
export interface TrendSeries {
  project_id: number;
  name: string;
  values: number[];
}

// One income-by-type slice; `share` is a 0–1 fraction of the grand total, `total` a converted
// base-currency amount. The server sorts these largest-first.
export interface CompositionSlice {
  type: string;
  label: string;
  share: number;
  total: number;
}

// One timeline bar; dates are 'YYYY-MM-DD', `end_date` null when the project is ongoing.
export interface TimelineProject {
  project_id: number;
  name: string;
  status: string;
  start_date: string;
  end_date: string | null;
}

// The full dashboard read model (GET /api/dashboard).
export interface Dashboard {
  base_currency: string;
  rankings: {
    by_monthly_revenue: RankedProject[];
    by_hourly_rate: RankedProject[];
  };
  trend: {
    months: string[]; // ['2026-02', …], length === requested months
    series: TrendSeries[];
  };
  composition: CompositionSlice[];
  timeline: TimelineProject[];
  warnings: {
    missing_rates: string[]; // sorted unique currency codes with no usable fx rate
  };
}

// A focus suggestion (GET /api/dashboard/suggestions). `message` is a complete, render-ready
// sentence; warnings are already ordered before infos by the server.
export interface Suggestion {
  rule: 'top_hourly' | 'declining' | 'revive' | 'concentration';
  severity: 'info' | 'warning';
  message: string;
  project_ids: number[];
}

// GET /api/dashboard?months=N — the assembled dashboard for the trend/composition/timeline
// horizon N (rankings ignore it and always use the trailing quarter).
export function getDashboard(months: number): Promise<Dashboard> {
  return api.get<Dashboard>(`/dashboard?months=${months}`);
}

// GET /api/dashboard/suggestions — the focus callout, loaded independently of the dashboard.
export function getSuggestions(): Promise<{ suggestions: Suggestion[] }> {
  return api.get<{ suggestions: Suggestion[] }>('/dashboard/suggestions');
}
