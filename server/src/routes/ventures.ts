import { Router } from 'express';
import { db } from '../db/index.js';

export const venturesRouter = Router();

venturesRouter.get('/', async (_req, res) => {
  const ventures = await db('ventures').select().orderBy('created_at', 'desc');
  res.json(ventures);
});
