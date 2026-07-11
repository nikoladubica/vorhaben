import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { env } from './env.js';
import { requireAuth } from './auth/middleware.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { projectsRouter } from './routes/projects.js';
import { projectTypesRouter } from './routes/projectTypes.js';
import { projectEntriesRouter, entriesRouter } from './routes/incomeEntries.js';
import { projectExpensesRouter, expensesRouter } from './routes/expenseEntries.js';
import { projectTimeLogsRouter, timeLogsRouter } from './routes/timeLogs.js';
import { projectNotesRouter, notesRouter } from './routes/notes.js';
import { projectMoodsRouter, moodsRouter } from './routes/moods.js';
import { canvasRouter } from './routes/canvas.js';
import { fxRatesRouter } from './routes/fxRates.js';
import { dashboardRouter } from './routes/dashboard.js';
import { accountRouter } from './routes/account.js';
import { tagsRouter } from './routes/tags.js';
import { exportRouter, importRouter } from './routes/exportImport.js';
import { voiceRouter } from './routes/voice.js';
import { checklistsRouter, checklistItemsRouter } from './routes/checklists.js';
import { remindersRouter } from './routes/reminders.js';
import { eventsRouter } from './routes/events.js';

export const app = express();

app.use(cors({ origin: env.corsOrigin, credentials: true }));
// Note bodies (raw Markdown) may be up to 1 MiB; the parser ceiling is set to 2mb so a full
// 1 MiB body_md plus its JSON envelope and escaping still reaches the route. The authoritative
// 1,048,576-byte cap lives in the notes validator (which returns 413), keeping one source of
// truth. Every other route enforces its own tighter field limits, so a wider parser ceiling does
// not loosen their contracts.
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

app.use('/api/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/projects', requireAuth, projectsRouter);
// Nested income-entry routes (/:id/entries) share the /api/projects mount; /:id is a single
// segment so it never captures /:id/entries, and projectsRouter falls through to here.
app.use('/api/projects', requireAuth, projectEntriesRouter);
// Nested expense-entry routes (/:id/expenses) share the /api/projects mount, same single-segment
// /:id pattern as the income-entry routes above, so /:id never captures /:id/expenses.
app.use('/api/projects', requireAuth, projectExpensesRouter);
// Nested time-log routes (/:id/time-logs) share the /api/projects mount, same pattern as the
// entry routes above: /:id is a single segment so it never captures /:id/time-logs.
app.use('/api/projects', requireAuth, projectTimeLogsRouter);
// Nested note routes (/:id/notes) share the /api/projects mount, same pattern again: /:id is a
// single segment so it never captures /:id/notes.
app.use('/api/projects', requireAuth, projectNotesRouter);
// Nested mood-stream routes (/:id/moods) share the /api/projects mount, same single-segment /:id
// pattern, so /:id never captures /:id/moods.
app.use('/api/projects', requireAuth, projectMoodsRouter);
// Canvas board: card placement + tray. Placed/tray cards reuse the projects/notes/metrics data,
// so this mounts alongside the other project-related routers.
app.use('/api/canvas', requireAuth, canvasRouter);
app.use('/api/project-types', requireAuth, projectTypesRouter);
app.use('/api/entries', requireAuth, entriesRouter);
app.use('/api/expenses', requireAuth, expensesRouter);
app.use('/api/time-logs', requireAuth, timeLogsRouter);
app.use('/api/notes', requireAuth, notesRouter);
// Mood stream: /moods/today drives the in-app daily nudge (in-app only — never push/email).
app.use('/api/moods', requireAuth, moodsRouter);
app.use('/api/fx-rates', requireAuth, fxRatesRouter);
app.use('/api/dashboard', requireAuth, dashboardRouter);
app.use('/api/account', requireAuth, accountRouter);
app.use('/api/tags', requireAuth, tagsRouter);
// Voice capture (§ voice-capture). Transcript parsing (side-effect free) + capability probe, then
// the four persist endpoints for the reviewed drafts. Each scopes rows by req.userId; a capture may
// be filed against a project or left unassigned. checklist-items has its own flat mount for the
// check/uncheck endpoint, mirroring the notes/single-note router split.
app.use('/api/voice', requireAuth, voiceRouter);
app.use('/api/checklists', requireAuth, checklistsRouter);
app.use('/api/checklist-items', requireAuth, checklistItemsRouter);
app.use('/api/reminders', requireAuth, remindersRouter);
app.use('/api/events', requireAuth, eventsRouter);
// CSV export/import (§8). Export streams one table per request; import parses a raw CSV text body
// (its own express.text parser with a 10 MB ceiling lives on the route, and an overflow surfaces
// as the shared 413 below).
app.use('/api/export', requireAuth, exportRouter);
app.use('/api/import', requireAuth, importRouter);

// In production the built client is served from the same origin as the API, so a
// self-host runs as a single container on one port (no CORS, no separate web server).
// Static assets first, then an SPA fallback that returns index.html for any non-API,
// non-file route so client-side routing works on refresh/deep-link.
if (env.nodeEnv === 'production') {
  app.use(express.static(env.clientDistPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) {
      next();
      return;
    }
    res.sendFile(path.join(env.clientDistPath, 'index.html'));
  });
}

// Body-parser overflow handler. A payload above the 2mb parser ceiling throws before any route
// runs; catch just that case and answer with a consistent JSON 413 (instead of Express's default
// HTML). Everything else passes through untouched, so existing routes' error behavior is
// unchanged.
app.use(
  (
    err: Error & { type?: string; status?: number },
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (err.type === 'entity.too.large' || err.status === 413) {
      res.status(413).json({ error: 'payload_too_large' });
      return;
    }
    next(err);
  },
);
