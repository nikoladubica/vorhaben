import type { Knex } from 'knex';
import { db } from '../db/index.js';

// The minimal slice of a project needed to authorize entry access and resolve a default
// currency. This is deliberately lighter than projects.ts's `fetchOwnedProject` (which also
// aggregates tags for the projects API response) — callers here only need ownership + the
// project's rate currency.
export interface OwnedProject {
  id: number;
  user_id: number;
  rate_currency: string | null;
}

/**
 * Load an owned, non-soft-deleted project. Returns the project or undefined if it does not
 * exist, belongs to another user, or is soft-deleted — the route layer turns undefined into
 * a 404 (both reads and writes on a soft-deleted project must 404).
 *
 * `executor` defaults to the shared connection but accepts a transaction so ownership can be
 * checked inside a larger unit of work.
 */
export async function assertProjectOwned(
  userId: number,
  projectId: number,
  executor: Knex | Knex.Transaction = db,
): Promise<OwnedProject | undefined> {
  const row = await executor('projects')
    .where({ id: projectId, user_id: userId })
    .whereNull('deleted_at')
    .first('id', 'user_id', 'rate_currency');
  return row as OwnedProject | undefined;
}
