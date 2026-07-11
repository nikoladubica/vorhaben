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

// GET /api/signals — the caller's per-project signals, most-concerning first (empty when quiet).
export function getSignals(): Promise<{ signals: Signal[] }> {
  return api.get<{ signals: Signal[] }>('/signals');
}
