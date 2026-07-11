import { Router } from 'express';
import { buildMatrixForUser } from '../domain/matrix.js';

// Mounted at /api/matrix behind requireAuth (see app.ts). The Worth-It Matrix read model
// (breaktrough.md §2.6), computed on demand: every query inside buildMatrixForUser is user-scoped
// and soft-delete aware. Unlike /api/signals it returns EVERY active project (plottable or not) so
// the client can plot the quadrant scatter and list the unplottable ones honestly below it.
export const matrixRouter = Router();

// GET /api/matrix — the combined per-project payload (rate + monthly hours + trend + swing +
// confidence + First Signal sentence) plus the portfolio median rate for the X quadrant boundary.
matrixRouter.get('/', async (req, res) => {
  const userId = req.userId as number;
  const matrix = await buildMatrixForUser(userId);
  res.json(matrix);
});
