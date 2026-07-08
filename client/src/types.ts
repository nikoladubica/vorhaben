// Client-side mirror of the server response shapes. Field names stay snake_case exactly
// as the API delivers them (see server/src/routes/projects.ts and projectTypes.ts).

// The 7 compensation models — keep in sync with server/src/domain/constants.ts.
export type CompensationModel =
  | 'hourly'
  | 'salary_monthly'
  | 'salary_biweekly'
  | 'salary_weekly'
  | 'fixed'
  | 'commission'
  | 'variable';

// Project lifecycle statuses (§1.2). Mirrors the DB enum on projects.status.
export type ProjectStatus = 'idea' | 'active' | 'paused' | 'ended';

// A project as returned by GET /api/projects and /api/projects/:id. Dates arrive as
// YYYY-MM-DD strings; rate_amount is a decimal string (or null) — amounts stay strings
// end to end (ticket 04 convention).
export interface Project {
  id: number;
  user_id: number;
  name: string;
  type: string;
  description: string | null;
  status: ProjectStatus;
  start_date: string;
  end_date: string | null;
  compensation_model: CompensationModel;
  rate_amount: string | null;
  rate_currency: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  tags: string[];
}

// A project type from GET /api/project-types (reference lookup for the type select).
export interface ProjectType {
  id: string;
  label: string;
}

// The write payload for create (POST) and update (PATCH). rate_amount is a number (or null)
// at the API boundary even though it is a string in form state.
export interface ProjectPayload {
  name: string;
  type: string;
  description: string | null;
  status: ProjectStatus;
  start_date: string;
  end_date: string | null;
  compensation_model: CompensationModel;
  rate_amount: number | null;
  rate_currency: string | null;
  tags: string[];
}
