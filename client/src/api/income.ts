// Typed cross-project monthly income call built on the shared `api` helper (credentials, JSON and
// ApiError are handled there — see client/src/api.ts). The interfaces mirror the server response
// shape of GET /api/entries?from=&to= (server/src/routes/incomeEntries.ts); field names stay
// snake_case as the API delivers them, and money stays a decimal string (no float drift).

import { api } from '../api';

// One income entry within the selected month. `amount`/`currency` are the ORIGINAL, as entered;
// `converted` is that amount in the user's base currency (summed server-side). `source` is
// 'expected' for an auto-generated salary row. `missing_rate` is true when no fx rate existed, in
// which case `converted` equals `amount` unconverted.
export interface IncomeEntry {
  id: number;
  date: string; // 'YYYY-MM-DD'
  project_id: number;
  name: string;
  note: string | null;
  amount: string;
  currency: string;
  source: 'manual' | 'expected';
  converted: string;
  missing_rate: boolean;
}

// One project's slice of the month, in base currency. `share` is a 0–1 fraction of the grand total;
// the server sorts these largest-first.
export interface IncomeByProject {
  project_id: number;
  name: string;
  total: string;
  share: number;
}

// GET /api/entries?from=&to= read model: the month's entries, per-project breakdown, and grand
// total — all base-currency figures already converted server-side.
export interface IncomeMonth {
  base_currency: string;
  from: string;
  to: string;
  entries: IncomeEntry[];
  by_project: IncomeByProject[];
  total: string;
}

// Fetch every entry across owned projects for the inclusive [from, to] range (a calendar month).
export function getIncome(from: string, to: string): Promise<IncomeMonth> {
  const params = new URLSearchParams({ from, to });
  return api.get<IncomeMonth>(`/entries?${params.toString()}`);
}
