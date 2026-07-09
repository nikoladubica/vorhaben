// Typed expense-entry API calls built on the shared `api` helper (credentials, JSON, and ApiError
// with the 422 `fields` map are handled there — see client/src/api.ts). Mirrors api/entries.ts,
// MINUS the confirm call: expenses have no 'expected' source to confirm.
//
// Nested reads/creates live under /projects/:id/expenses; single-row PATCH/DELETE use the flat
// /expenses/:id paths (see server/src/routes/expenseEntries.ts). `amount` becomes a number only
// here, at the API boundary — it stays a string everywhere in component state.

import { api } from '../api';
import type { ExpenseEntry, ExpenseEntryInput } from '../types';

export interface ExpenseRange {
  from?: string;
  to?: string;
}

// Build the ?from=&to= querystring, omitting empty values (mirrors entries.ts buildQuery).
function buildQuery(range: ExpenseRange): string {
  const params = new URLSearchParams();
  if (range.from) params.set('from', range.from);
  if (range.to) params.set('to', range.to);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function listExpenses(
  projectId: number,
  range: ExpenseRange = {},
): Promise<ExpenseEntry[]> {
  return api.get<ExpenseEntry[]>(`/projects/${projectId}/expenses${buildQuery(range)}`);
}

export function createExpense(
  projectId: number,
  input: ExpenseEntryInput,
): Promise<ExpenseEntry> {
  return api.post<ExpenseEntry>(`/projects/${projectId}/expenses`, input);
}

export function updateExpense(
  id: number,
  input: Partial<ExpenseEntryInput>,
): Promise<ExpenseEntry> {
  return api.patch<ExpenseEntry>(`/expenses/${id}`, input);
}

export function deleteExpense(id: number): Promise<void> {
  return api.del<void>(`/expenses/${id}`);
}
