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

export const app = express();

app.use(cors({ origin: env.corsOrigin, credentials: true }));
app.use(express.json());
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
app.use('/api/project-types', requireAuth, projectTypesRouter);
app.use('/api/entries', requireAuth, entriesRouter);
app.use('/api/time-logs', requireAuth, timeLogsRouter);
