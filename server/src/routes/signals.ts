import { Router } from 'express';
import { buildSignalsForUser } from '../domain/signals.js';
import { buildNudgesForUser } from '../domain/drift.js';

// Mounted at /api/signals behind requireAuth (see app.ts). The mood analysis engine + First Signal
// (breaktrough.md §2.3–§2.4) plus the drift nudges (§2.7), computed on demand: every query inside
// buildSignalsForUser / buildNudgesForUser is user-scoped and soft-delete aware. Silent projects are
// omitted and the rest are ordered most-concerning first; an empty { signals: [], nudges: [] } is a
// valid, common response.
export const signalsRouter = Router();

// GET /api/signals — the caller's First Signal sentences and drift nudges. `nudges` renders inside
// the same Signals panel (ticket 06): no new banner, no badge, no count. Building the nudges spends
// this week's budget (append-only nudge_log), so a repeat request the same week stays silent.
signalsRouter.get('/', async (req, res) => {
  const userId = req.userId as number;
  const [signals, nudges] = await Promise.all([
    buildSignalsForUser(userId),
    buildNudgesForUser(userId),
  ]);
  res.json({ signals, nudges });
});
