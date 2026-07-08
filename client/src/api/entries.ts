// Typed income-entry API calls built on the shared `api` helper. The helper already handles
// credentials, JSON, and ApiError (with the 422 `fields` map) — see client/src/api.ts.
//
// Nested reads/creates live under /projects/:id/entries; single-entry PATCH/DELETE use the flat
// /entries/:id paths (see server/src/routes/incomeEntries.ts). `amount` becomes a number only
// here, at the API boundary — it stays a string everywhere in component state.

import { api } from '../api';
import type { IncomeEntry, IncomeEntryInput } from '../types';

export interface EntryRange {
  from?: string;
  to?: string;
}

// Build the ?from=&to= querystring, omitting empty values (mirrors projects.ts buildQuery).
function buildQuery(range: EntryRange): string {
  const params = new URLSearchParams();
  if (range.from) params.set('from', range.from);
  if (range.to) params.set('to', range.to);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function listEntries(
  projectId: number,
  range: EntryRange = {},
): Promise<IncomeEntry[]> {
  return api.get<IncomeEntry[]>(`/projects/${projectId}/entries${buildQuery(range)}`);
}

export function createEntry(
  projectId: number,
  input: IncomeEntryInput,
): Promise<IncomeEntry> {
  return api.post<IncomeEntry>(`/projects/${projectId}/entries`, input);
}

export function updateEntry(
  id: number,
  input: Partial<IncomeEntryInput>,
): Promise<IncomeEntry> {
  return api.patch<IncomeEntry>(`/entries/${id}`, input);
}

export function deleteEntry(id: number): Promise<void> {
  return api.del<void>(`/entries/${id}`);
}
