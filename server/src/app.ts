import express from 'express';
import cors from 'cors';
import { env } from './env.js';
import { healthRouter } from './routes/health.js';
import { venturesRouter } from './routes/ventures.js';

export const app = express();

app.use(cors({ origin: env.corsOrigin }));
app.use(express.json());

app.use('/api/health', healthRouter);
app.use('/api/ventures', venturesRouter);
