import { Router } from 'express';
import { db } from '../db/index.js';

export const healthRouter = Router();

healthRouter.get('/', async (_req, res) => {
  try {
    await db.raw('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (error) {
    res.status(503).json({ status: 'error', db: 'unreachable', message: (error as Error).message });
  }
});
