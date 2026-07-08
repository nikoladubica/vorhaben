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
