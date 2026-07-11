import { Router } from 'express';
import { buildSignalsForUser } from '../domain/signals.js';

// Mounted at /api/signals behind requireAuth (see app.ts). The mood analysis engine + First Signal
// (breaktrough.md §2.3–§2.4), computed on demand: every query inside buildSignalsForUser is
// user-scoped and soft-delete aware. Silent projects are omitted and the rest are ordered
// most-concerning first; an empty { signals: [] } is a valid, common response.
export const signalsRouter = Router();

// GET /api/signals — the per-project First Signal sentences for the caller's active projects.
signalsRouter.get('/', async (req, res) => {
  const userId = req.userId as number;
  const signals = await buildSignalsForUser(userId);
  res.json({ signals });
});
