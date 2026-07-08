import { Router } from 'express';
import { db } from '../db/index.js';

// Read-only lookup of the project types (reference data, seeded in the core migration).
// Mounted behind requireAuth in app.ts. Not user-scoped — types are global reference data.
export const projectTypesRouter = Router();

interface ProjectTypeRow {
  id: string;
  label: string;
  sort_order: number;
}

projectTypesRouter.get('/', async (_req, res) => {
  const types = await db<ProjectTypeRow>('project_types')
    .orderBy('sort_order', 'asc')
    .select('id', 'label');
  res.json(types);
});
