import { Router } from 'express';
import { buildDashboard } from '../domain/dashboard.js';

// Mounted at /api/dashboard behind requireAuth (see app.ts). Read-only aggregation of the
// caller's projects into the §4.1 dashboard views. Every underlying query is user-scoped and
// soft-delete aware inside buildDashboard().
export const dashboardRouter = Router();

// `months` bounds the trend/composition/timeline horizon (NOT the ranking window, which is always
// the canonical trailing quarter). Default 6, clamped to a sane 1–36 range.
const MIN_MONTHS = 1;
const MAX_MONTHS = 36;
const DEFAULT_MONTHS = 6;

// Parse the optional ?months= query param. Returns the integer, or null when it is present but
// not an integer within [MIN_MONTHS, MAX_MONTHS]. Absent/empty → the default.
function parseMonths(raw: unknown): number | null {
  if (raw === undefined || raw === '') return DEFAULT_MONTHS;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < MIN_MONTHS || value > MAX_MONTHS) return null;
  return value;
}

// GET /api/dashboard?months=6 — the assembled dashboard read model.
dashboardRouter.get('/', async (req, res) => {
  const userId = req.userId as number;

  const months = parseMonths(req.query.months);
  if (months === null) {
    res.status(422).json({ error: 'validation', fields: { months: 'invalid' } });
    return;
  }

  const dashboard = await buildDashboard(userId, { months });
  res.json(dashboard);
});
