// Typed Quarterly Statement calls built on the shared `api` helper (credentials, JSON, and ApiError
// are handled there — see client/src/api.ts). The interfaces below mirror the server response
// shapes exactly (server/src/domain/statement.ts); field names stay snake_case as the API delivers
// them, and every money figure is already base-currency-converted server-side.
//
// The capstone (breaktrough.md §2.8 / ticket 07): a computed-on-demand statement of one quarter —
// the portfolio table, a prose narrative with mood quotes, and exactly one recommendation. Nothing
// is stored; a statement is a view of the history that is already the database.

import { api } from '../api';

// One selectable quarter for the period picker. `period` is the canonical id ("2026-Q2"); `finished`
// is true once the quarter has fully elapsed (drives the Dashboard "ready" line). Newest first.
export interface StatementPeriod {
  period: string;
  label: string;
  year: number;
  quarter: number;
  from: string;
  to: string;
  finished: boolean;
}

// The statement masthead — identity and provenance, printed verbatim.
export interface StatementHead {
  period: string;
  label: string;
  year: number;
  quarter: number;
  from: string;
  to: string;
  generated_at: string;
  base_currency: string;
  user_email: string;
}

// One reading in a project's mood trajectory. `valence` runs −2…+2 (drives the sparkline y); it is
// null for an explicitly cleared feeling, which the sparkline treats as a gap (never drawn through).
export interface TrajectoryPoint {
  at: string;
  value: string | null;
  valence: number | null;
}

// The engine's quarter-end read for a project. `direction` picks the verdict glyph; `sentence` is the
// full read shown on hover. Null when the engine has nothing to say.
export interface StatementVerdict {
  finding: string;
  sentence: string;
  direction: 'up' | 'down' | 'flat' | null;
  confidence: string;
  swing: string;
}

// One project's row in the portfolio table. Every money figure and `hours`/`total_revenue` is a
// number or null (render null as an em dash — never fabricate). `trajectory` may be short or empty.
export interface StatementPortfolioProject {
  project_id: number;
  name: string;
  type: string;
  status: string;
  monthly_revenue: number | null;
  monthly_expenses: number | null;
  monthly_net: number | null;
  effective_hourly_rate: number | null;
  hours: number | null;
  total_revenue: number | null;
  trajectory: TrajectoryPoint[];
  verdict: StatementVerdict | null;
  harsh_swing: boolean;
}

// A named superlative in the aggregates strip (best rate / best revenue / heaviest). Null when there
// is no qualifying project this quarter.
export interface AggregateRef {
  project_id: number;
  name: string;
  value: number;
}

// The quarter's headline aggregates. `prev_monthly_net` and `trend_direction` compare against the
// prior quarter; any figure may be null when it cannot be computed.
export interface StatementAggregates {
  total_monthly_revenue: number | null;
  total_monthly_net: number | null;
  prev_monthly_net: number | null;
  trend_direction: 'up' | 'down' | 'flat' | null;
  best_by_rate: AggregateRef | null;
  best_by_revenue: AggregateRef | null;
  heaviest: AggregateRef | null;
}

// A project that ended in the quarter — honored, not hidden. Lifetime totals are all-time; the
// `ending_note` is the teach-note filed during the ending ritual (null when none was written).
export interface EndedProject {
  project_id: number;
  name: string;
  start_date: string;
  end_date: string;
  lifespan_days: number;
  lifetime_revenue: number | null;
  lifetime_hours: number | null;
  ending_note: string | null;
}

// Narrative events for the quarter. `harsh_swings` names projects to watch; `weeks_closed` is the
// count of weekly closes recorded (out of 13 possible).
export interface StatementEvents {
  ended: EndedProject[];
  harsh_swings: { project_id: number; name: string }[];
  weeks_closed: number;
}

// A mood why-note quoted back near a turn in a project's curve — verbatim, dated. Never truncated.
export interface StatementQuote {
  project_id: number;
  project_name: string;
  date: string;
  text: string;
}

// The single recommendation for next quarter. `project_id` is null for a portfolio-wide suggestion.
export interface StatementRecommendation {
  kind: string;
  project_id: number | null;
  sentence: string;
}

// The full statement model for one quarter (GET /api/statements/:period).
export interface Statement {
  head: StatementHead;
  portfolio: StatementPortfolioProject[];
  aggregates: StatementAggregates;
  events: StatementEvents;
  quotes: StatementQuote[];
  recommendation: StatementRecommendation | null;
}

// GET /api/statements — the periods with enough data to render, newest first.
export function getStatementPeriods(): Promise<{ periods: StatementPeriod[] }> {
  return api.get<{ periods: StatementPeriod[] }>('/statements');
}

// GET /api/statements/:period — the full computed model, or a 404 (ApiError) for a malformed period.
export function getStatement(period: string): Promise<Statement> {
  return api.get<Statement>(`/statements/${encodeURIComponent(period)}`);
}
