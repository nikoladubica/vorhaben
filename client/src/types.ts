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

// The 8 canvas feelings — a closed list; keep in sync with the server enum. How the work FEELS,
// independent of the numbers (screen 14).
export type Feeling =
  | 'happy'
  | 'sad'
  | 'miserable'
  | 'excited'
  | 'opportunistic'
  | 'pessimistic'
  | 'stressed'
  | 'grateful';

// The 3 canvas trends — how the work is GOING. Semantic (good/stable/bad), never the red accent.
export type Trend = 'good' | 'stable' | 'bad';

// The canvas connection types — a closed list; keep in sync with server LINK_TYPES. A link is a real
// project relationship (screen 14), edited on the canvas but readable beyond it. `parent`: the `from`
// project is the parent, the `to` project is the part/child. `blocks`: the `from` project is blocking
// the `to` project from progressing. Both draw from ▸ to; no red anywhere (see design.md).
export type LinkType = 'parent' | 'blocks';

// A typed connection between two of the user's projects, from GET /api/canvas (`links`). Ids are the
// project ids the link joins; the canvas only draws a link when BOTH endpoints are currently placed,
// but the row survives a card's removal from the board — it is a project relationship, not decoration.
export interface ProjectLink {
  id: number;
  from_project_id: number;
  to_project_id: number;
  type: LinkType;
}

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
  // Canvas annotations (screen 14) — both null until the user sets them; they never touch the
  // project's numbers.
  feeling: Feeling | null;
  trend: Trend | null;
  // The optional "what did it teach you?" note filed during the ending ritual (§2.7). Null until a
  // project is ended with a note; never couples to deleted_at, and survives reactivation.
  ending_note: string | null;
}

// A project row as returned by the LIST endpoint (GET /api/projects), enriched with the same
// normalized figures the dashboard uses. `total_revenue` is all-time; `monthly_revenue`,
// `monthly_net` and `effective_hourly_rate` are the trailing-3-month window. Each is null when
// unavailable (no contributing entries, or no logged hours for the rate). The single-project GET
// does NOT carry these — it's the plain `Project`.
export interface ProjectWithMetrics extends Project {
  total_revenue: number | null;
  monthly_revenue: number | null;
  monthly_net: number | null;
  effective_hourly_rate: number | null;
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
  // Set only by the ending ritual (§2.7). Omitted by every other write path, so it is optional and
  // never clobbers an existing note on an unrelated PATCH.
  ending_note?: string | null;
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
  total_expenses: number | null;
  monthly_revenue: number | null;
  monthly_expenses: number | null;
  monthly_net: number | null;
  effective_hourly_rate: number | null;
  hours_in_window: number;
  // Actual months spanned by the trailing window (≤ 3, shorter for young projects) — lets the UI
  // express windowed hours as a per-month figure.
  window_months: number;
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

// A single event in a project's mood stream (ticket 01 / §2.2). The project still shows one
// current feeling; underneath, every change is appended here — like a bank ledger. `value` is one
// of the closed FEELINGS or null (feeling cleared); `note` is the optional one-line "why" (stored
// verbatim). `source` is manual | nudge | weekly_close. `source_transcript` is never exposed in
// list reads. `created_at` is a real ISO timestamp (unlike the YYYY-MM-DD dates elsewhere). Mirrors
// the row shape returned by server/src/routes/moods.ts.
export interface MoodEvent {
  id: number;
  value: Feeling | null;
  note: string | null;
  source: string;
  created_at: string;
}

// A note as returned by GET /api/notes — the cross-project journal feed (screen 10). Same shape
// as Note plus the owning project's name, so the standalone browser can group rows by project
// without a second lookup. Server orders by project name, then newest-touched first.
export interface NoteListItem extends Note {
  project_name: string;
}

// A card on the canvas board (screen 14), from GET /api/canvas. `x`/`y` are present only on
// `placed` items (board coordinates in px, snapped to a 24px grid); tray items omit them. The
// money figures mirror the project-metrics headline (§2.2) and are null when uncomputable —
// render as an em dash. `note_count` drives the file-chip count; `feeling`/`trend` are the same
// closed lists as the project annotations.
export interface CanvasItem {
  project_id: number;
  name: string;
  type: string;
  type_label: string;
  status: ProjectStatus;
  feeling: Feeling | null;
  trend: Trend | null;
  note_count: number;
  monthly_revenue: number | null;
  effective_hourly_rate: number | null;
  base_currency: string;
  x?: number;
  y?: number;
}

// The full canvas payload from GET /api/canvas — cards already on the board vs. still in the tray,
// plus every live project-to-project link (drawn only when both endpoints are placed, § canvas).
export interface CanvasBoard {
  placed: CanvasItem[];
  tray: CanvasItem[];
  links: ProjectLink[];
}
