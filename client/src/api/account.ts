// Account settings calls built on the shared `api` helper (credentials, JSON, and ApiError with
// the `fields` map are handled there — see client/src/api.ts).

import { api } from '../api';
import type { User } from '../auth/auth-context';

// PATCH /api/account — change the base currency. Returns the updated user; a bad code yields a
// 400 ApiError with error 'invalid_base_currency'.
export function updateBaseCurrency(code: string): Promise<User> {
  return api.patch<User>('/account', { base_currency: code });
}

// PATCH /api/account — partial update of own-account settings. Only the fields present are applied;
// the server requires at least one. Returns the updated user. Used by the onboarding wizard (design
// screen "03") to persist base currency + the track-hours choice in a single call.
export function updateAccount(patch: {
  base_currency?: string;
  track_hours?: boolean;
}): Promise<User> {
  return api.patch<User>('/account', patch);
}

// The hosted-assistant usage meter (ticket 12). Deliberately carries NO raw token count — the
// assistant allowance is only ever shown as a percentage. `warning` at ≥80%, `capped` once the
// general budget is spent (chat pauses; voice capture keeps working). `resetsAt` is an ISO instant.
export interface AssistantUsage {
  percent: number;
  warning: boolean;
  capped: boolean;
  resetsAt: string;
  // Invoice-scan fair-use counter (ticket 14). Scan COUNTS are user-facing — the no-raw-numbers rule
  // is tokens-only. Null when the user is BYOK (uncapped).
  scans: { used: number; cap: number; resetsAt: string } | null;
}

// GET /api/account/usage — the current billing window's assistant usage state.
export function getAssistantUsage(): Promise<AssistantUsage> {
  return api.get<AssistantUsage>('/account/usage');
}
