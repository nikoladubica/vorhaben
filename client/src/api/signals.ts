// Typed mood-signal calls built on the shared `api` helper (credentials, JSON, and ApiError are
// handled there — see client/src/api.ts). The interface below mirrors the server response shape
// exactly (server/src/domain/signals.ts); field names stay snake_case as the API delivers them.
//
// The mood analysis engine + First Signal (breaktrough.md §2.3–§2.4): per active project, a single
// plain sentence read next to effective hourly rate, honestly labelled by confidence. `sentence`
// and `confidence` are the interface — `trend_score`/`fire`/`direction` travel for later screens
// (the Worth-It Matrix), but this ticket's UI renders words only. Red is never used for a signal.

import { api } from '../api';

// One project's First Signal. `sentence` is render-ready; `confidence` labels how much data backs
// it ('early' ≥3 days / 'pattern' ≥14 / 'established' ≥42) and `days` is the data span for the
// "N DAYS OF DATA" eyebrow. Silent projects are omitted server-side; the list is ordered
// most-concerning first.
export interface Signal {
  project_id: number;
  name: string;
  confidence: 'early' | 'pattern' | 'established';
  direction: 'up' | 'down' | 'flat' | null;
  energy_direction: 'up' | 'down' | 'flat' | null;
  fire: 'burning' | 'steady' | 'fading' | null;
  swing: 'none' | 'mild' | 'harsh';
  streak: number;
  trend_score: number;
  days: number;
  finding: string;
  sentence: string;
}

// A drift nudge (breaktrough.md §2.7): at most one per project per week, server-budgeted. Like a
// Signal it is sentence-first (the words ARE the interface), but it prompts a decision rather than
// reporting a read. `feeling_drift` = an established decline; `attention_drift` = an untouched active
// project offered a guilt-free ending. Rendered inside the Signals panel — never red, no badge, no
// count. Only `attention_drift` surfaces the direct "End it →" path.
export interface Nudge {
  project_id: number;
  name: string;
  kind: 'feeling_drift' | 'attention_drift';
  sentence: string;
}

// GET /api/signals — the caller's per-project signals (most-concerning first) plus drift nudges.
// Both arrays are empty when the engine is quiet.
export function getSignals(): Promise<{ signals: Signal[]; nudges: Nudge[] }> {
  return api.get<{ signals: Signal[]; nudges: Nudge[] }>('/signals');
}
