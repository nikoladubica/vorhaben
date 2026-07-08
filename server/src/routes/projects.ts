import { Router } from 'express';

export const projectsRouter = Router();

projectsRouter.get('/', async (_req, res) => {
  // TODO: ticket 03
  res.json([]);
});
