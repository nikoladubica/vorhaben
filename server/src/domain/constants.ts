// Single source of truth for the domain enums that live in code (not in the DB schema).
// See BUSINESS_LOGIC.md §1.1 (statuses) and §2 (compensation models).

// Compensation models (§2). compensation_model is stored as a plain string column and
// validated in the app layer against this list, so adding a model later touches only
// this file and needs no schema change.
export const COMPENSATION_MODELS = [
  'hourly',
  'salary_monthly',
  'salary_biweekly',
  'salary_weekly',
  'fixed',
  'commission',
  'variable',
] as const;

export type CompensationModel = (typeof COMPENSATION_MODELS)[number];

// Project statuses (§1.2). Mirrors the DB enum on projects.status.
export const PROJECT_STATUSES = ['idea', 'active', 'paused', 'ended'] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

// Self-reported check-in labels a user attaches to a project — validated in the app layer against
// these lists (plain string columns, no DB enum, mirroring compensation_model). These are
// app-validated closed lists; they were re-opened ONCE, by explicit owner decision on 2026-07-14
// (ticket 26 — see .claude/docs/breaktrough.md §4), which split the single mood question into two:
// FEELING ("how do you feel about it?") and TREND ("how is it going?"). Do not otherwise add,
// rename, or reorder.

// Writable FEELING check-in list (the 2026-07-14 six). The picker offers exactly these; `fine` is
// the neutral the old list was missing. Write validation accepts only these values.
export const FEELINGS = ['excited', 'happy', 'fine', 'stressed', 'sad', 'miserable'] as const;

export type WritableFeeling = (typeof FEELINGS)[number];

// Retired from pickers/writes on 2026-07-14 but present in historic mood_events rows (and old
// projects.feeling values) FOREVER — history is the product. They are never offered or accepted on
// new writes, yet they still score in the analysis engine so past events read exactly as before.
export const LEGACY_FEELINGS = ['grateful', 'opportunistic', 'pessimistic'] as const;

// The READ type: every feeling value that can appear on a stored row = writable ∪ legacy. Read
// paths (projects.feeling, mood_events.value, the engine's valence/energy maps) must cover all of
// these; write validation (isWritableFeeling) accepts only the current six.
export const ALL_FEELINGS = [...FEELINGS, ...LEGACY_FEELINGS] as const;

export type Feeling = (typeof ALL_FEELINGS)[number];

// Self-reported TREND check-in — the user's own "how is it going?" gut feel, promoted 2026-07-14
// from a canvas-only projects.trend column to a first-class prompted value with its own dated
// stream. NOTE: this is the user's gut feel, NOT the computed 3-month revenue trend from the
// normalization layer — the two are deliberately separate and must never be conflated. The list
// grew from 3 to 5; the middle three (good/stable/bad) are the original DB values, so promoting it
// needs no data migration — only the two ends (thriving/failing) are new.
export const TRENDS = ['thriving', 'good', 'stable', 'bad', 'failing'] as const;

export type Trend = (typeof TRENDS)[number];

// Membership predicates. Used by write validation to accept only current values without tripping
// over the narrowed array element types (FEELINGS is the six-member writable list, so its native
// `.includes` rejects the wider Feeling read type at the type level).
export function isWritableFeeling(value: string): value is WritableFeeling {
  return (FEELINGS as readonly string[]).includes(value);
}

export function isFeeling(value: string): value is Feeling {
  return (ALL_FEELINGS as readonly string[]).includes(value);
}

export function isTrend(value: string): value is Trend {
  return (TRENDS as readonly string[]).includes(value);
}

// Canvas connection types. A project_links row is directed from ▸ to; the type labels the
// relationship. `parent` = the `from` project is the parent, the `to` project is the child;
// `blocks` = the `from` project blocks the `to` project. Validated in the app layer against this
// list (plain string column, no DB enum). CLOSED list, order significant: do not add, rename, or
// reorder.
export const LINK_TYPES = ['parent', 'blocks'] as const;

export type LinkType = (typeof LINK_TYPES)[number];
