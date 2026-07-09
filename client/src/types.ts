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

// An income entry from GET /api/projects/:id/entries (newest first). `date` is YYYY-MM-DD;
// `amount` is a decimal string — amounts stay strings end to end (ticket 04 convention).
// `source` is 'manual' for user-entered rows, 'expected' for salary-model projected rows.
export interface IncomeEntry {
  id: number;
  project_id: number;
  date: string;
  amount: string;
  currency: string;
  note: string | null;
  source: 'manual' | 'expected';
  created_at: string;
}

// Write payload for creating an entry (POST). `amount` is a number at the API boundary even
// though it stays a string in component state; `currency` is optional (server defaults it to
// the project rate currency → user base currency). `date` and `amount` are required on create.
export interface IncomeEntryInput {
  date: string;
  amount: number;
  currency?: string;
  note?: string | null;
}

// An expense entry from GET /api/projects/:id/expenses (newest first). Mirrors IncomeEntry MINUS
// `source` — expenses are always user-entered (there is no auto-generated "expected" expense).
// `date` is YYYY-MM-DD; `amount` is a decimal string (positive = money out); amounts stay strings
// end to end (ticket 04 convention).
export interface ExpenseEntry {
  id: number;
  project_id: number;
  date: string;
  amount: string;
  currency: string;
  note: string | null;
  created_at: string;
}

// Write payload for creating an expense (POST). `amount` is a number at the API boundary even
// though it stays a string in component state; `currency` is optional (server defaults it to the
// project rate currency → user base currency). `date` and `amount` are required on create.
export interface ExpenseEntryInput {
  date: string;
  amount: number;
  currency?: string;
  note?: string | null;
}

// Per-project normalized headline figures from GET /api/projects/:id/metrics (§2.2 / §8), in the
// user's base currency. Any money figure is null when it cannot be computed (no contributing
// entries, or no logged hours for the rate). `monthly_net` = revenue − expenses.
export interface ProjectMetrics {
  project_id: number;
  base_currency: string;
  total_revenue: number | null;
  monthly_revenue: number | null;
  monthly_expenses: number | null;
  monthly_net: number | null;
  effective_hourly_rate: number | null;
  hours_in_window: number;
}

// A time log from GET /api/projects/:id/time-logs (newest first). `date` is YYYY-MM-DD;
// `hours` is a decimal string and stays a string end to end (0 < hours <= 168).
export interface TimeLog {
  id: number;
  project_id: number;
  date: string;
  // Inclusive range end — a log may cover date … end_date with `hours` as the TOTAL for the
  // whole range. Null for the ordinary single-day log.
  end_date: string | null;
  hours: string;
  note: string | null;
  created_at: string;
}

// Write payload for creating a time log (POST). `hours` travels as a string ("7.5") to avoid
// float drift; the server enforces hours > 0 and a range-dependent cap (max(168, 24 h × days)).
export interface TimeLogInput {
  date: string;
  end_date?: string | null;
  hours: string;
  note?: string | null;
}

// A Markdown journal note from GET /api/projects/:id/notes (newest-touched first, §3). `body_md`
// is RAW Markdown — the server stores and returns it byte-for-byte, so the client render path is
// the security boundary (see components/markdown/Markdown.tsx). `created_at`/`updated_at` are real
// timestamps and arrive as ISO strings over JSON (unlike the YYYY-MM-DD dates elsewhere). Mirrors
// the NoteRow shape in server/src/routes/notes.ts.
export interface Note {
  id: number;
  project_id: number;
  title: string;
  body_md: string;
  created_at: string;
  updated_at: string;
}

// Write payload for creating/updating a note. `title` is required and non-empty; `body_md` is
// sent verbatim (server caps it at 1 MiB → 413). On PATCH callers pass a Partial of this.
export interface NoteInput {
  title: string;
  body_md: string;
}
