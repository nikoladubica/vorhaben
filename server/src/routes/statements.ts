import { Router } from 'express';
import { buildStatementForUser, listStatementPeriods } from '../domain/statement.js';

// Mounted at /api/statements behind requireAuth (see app.ts). The Quarterly Statement
// (breaktrough.md §2.8), COMPUTED ON DEMAND — nothing is stored or cached, so a past quarter stays
// consistent with any later data correction. Every query inside the domain loaders is user-scoped
// and soft-delete aware; all money is converted server-side to the user's base currency.
export const statementsRouter = Router();

// GET /api/statements — the quarters with enough data to render (any income entry or mood event),
// newest first. Each carries `finished`; the client shows the Dashboard ready-line for the newest
// finished quarter only. An empty array is a valid, common result (a fresh account).
statementsRouter.get('/', async (req, res) => {
  const userId = req.userId as number;
  const periods = await listStatementPeriods(userId);
  res.json({ periods });
});

// GET /api/statements/:period — the full quarter model for a "YYYY-Qn" period (e.g. 2026-Q2). A
// malformed period returns 404 (the loader returns null); a well-formed period with no activity
// still returns a valid, mostly-empty statement.
statementsRouter.get('/:period', async (req, res) => {
  const userId = req.userId as number;
  const statement = await buildStatementForUser(userId, req.params.period);
  if (statement === null) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json(statement);
});
