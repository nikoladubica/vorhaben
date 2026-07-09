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

// Canvas-board annotations. These are self-reported labels a user attaches to a card on the
// canvas board — validated in the app layer against these lists (plain string columns, no DB
// enum, mirroring compensation_model). CLOSED lists: do not add, rename, or reorder.
// NOTE: `trend` here is the user's own gut feel, NOT the computed 3-month revenue trend from the
// normalization layer — the two are deliberately separate and must never be conflated.
export const FEELINGS = [
  'happy',
  'sad',
  'miserable',
  'excited',
  'opportunistic',
  'pessimistic',
  'stressed',
  'grateful',
] as const;

export type Feeling = (typeof FEELINGS)[number];

export const TRENDS = ['good', 'stable', 'bad'] as const;

export type Trend = (typeof TRENDS)[number];
