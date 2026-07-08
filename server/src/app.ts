import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './env.js';
import { requireAuth } from './auth/middleware.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { projectsRouter } from './routes/projects.js';
import { projectTypesRouter } from './routes/projectTypes.js';
import { projectEntriesRouter, entriesRouter } from './routes/incomeEntries.js';
import { projectTimeLogsRouter, timeLogsRouter } from './routes/timeLogs.js';
import { projectNotesRouter, notesRouter } from './routes/notes.js';
import { fxRatesRouter } from './routes/fxRates.js';
import { dashboardRouter } from './routes/dashboard.js';

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
// Nested time-log routes (/:id/time-logs) share the /api/projects mount, same pattern as the
// entry routes above: /:id is a single segment so it never captures /:id/time-logs.
app.use('/api/projects', requireAuth, projectTimeLogsRouter);
// Nested note routes (/:id/notes) share the /api/projects mount, same pattern again: /:id is a
// single segment so it never captures /:id/notes.
app.use('/api/projects', requireAuth, projectNotesRouter);
app.use('/api/project-types', requireAuth, projectTypesRouter);
app.use('/api/entries', requireAuth, entriesRouter);
app.use('/api/time-logs', requireAuth, timeLogsRouter);
app.use('/api/notes', requireAuth, notesRouter);
app.use('/api/fx-rates', requireAuth, fxRatesRouter);
app.use('/api/dashboard', requireAuth, dashboardRouter);

// Body-parser overflow handler. A payload above the 2mb parser ceiling throws before any route
// runs; catch just that case and answer with a consistent JSON 413 (instead of Express's default
// HTML). Everything else passes through untouched, so existing routes' error behavior is
// unchanged.
app.use((
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
});
