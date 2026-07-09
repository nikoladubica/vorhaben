// Pure status derivation — no DB access. See BUSINESS_LOGIC.md §1.3 (lifecycle rules).
//
// `status` is derived, not stored as free manual input: the client expresses a manual
// *intent* (`paused` / `idea`) which we combine with the start/end dates and today's date.
// `ended` is never accepted as manual input — it is only ever derived from a past end_date.
import type { ProjectStatus } from './constants.js';

// The manual intent a client can express via the request's `status` field.
// `active` / nothing maps to `null` (no manual flag).
export type StatusFlag = 'paused' | 'idea' | null;

export interface DeriveStatusInput {
  status_flag: StatusFlag;
  start_date: string; // YYYY-MM-DD
  end_date: string | null; // YYYY-MM-DD
  today: string; // YYYY-MM-DD
}

// All dates are YYYY-MM-DD, which sorts lexically as it does chronologically, so plain
// string comparison is correct and avoids any timezone/Date parsing pitfalls.
export function deriveStatus({
  status_flag,
  start_date,
  end_date,
  today,
}: DeriveStatusInput): ProjectStatus {
  // 1. Not yet started (manual idea flag or a future start date).
  if (status_flag === 'idea' || start_date > today) return 'idea';
  // 2. An end date of today or in the past ends the project — this dominates a stale paused flag.
  if (end_date !== null && end_date <= today) return 'ended';
  // 3. Manual pause.
  if (status_flag === 'paused') return 'paused';
  // 4. Default.
  return 'active';
}

// Recover the manual intent from an already-derived stored status, so a PATCH that does
// not touch `status` preserves the user's paused/idea intent when re-deriving.
export function flagFromStatus(status: ProjectStatus): StatusFlag {
  if (status === 'paused') return 'paused';
  if (status === 'idea') return 'idea';
  return null;
}
