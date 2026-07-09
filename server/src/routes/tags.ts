import { Router } from 'express';
import type { Knex } from 'knex';
import { db } from '../db/index.js';

// Mounted at /api/tags behind requireAuth (see app.ts). Every query is scoped to req.userId; tags
// are per-user labels (unique(user_id, name), utf8mb4_*_ai_ci collation → case-insensitive).
export const tagsRouter = Router();

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

// tags row plus its usage count. project_count arrives from COUNT() as a string under mysql2, so
// it is coerced to a number before leaving the route.
interface RawTagRow {
  id: number;
  name: string;
  project_count: string | number;
}

function mapTagRow(row: RawTagRow) {
  return { id: row.id, name: row.name, project_count: Number(row.project_count) };
}

// Base query: each of the user's tags with its project usage count. Left join keeps tags that are
// attached to zero projects (count 0). `executor` may be the db or a transaction.
function tagCountQuery(executor: Knex | Knex.Transaction, userId: number) {
  return executor('tags')
    .leftJoin('project_tags', 'project_tags.tag_id', 'tags.id')
    .where('tags.user_id', userId)
    .groupBy('tags.id')
    .select('tags.id', 'tags.name', executor.raw('COUNT(project_tags.tag_id) as project_count'));
}

// Parse a :id route param to a positive integer, or null when it is not one.
function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

// ---------------------------------------------------------------------------
// Routes (mounted behind requireAuth; every query scoped to req.userId)
// ---------------------------------------------------------------------------

// GET /api/tags — the caller's tags with usage counts, alphabetical by name.
tagsRouter.get('/', async (req, res) => {
  const userId = req.userId as number;
  const rows = (await tagCountQuery(db, userId).orderBy('tags.name')) as RawTagRow[];
  res.json(rows.map(mapTagRow));
});

// PATCH /api/tags/:id — rename a tag. If the new name collides (case-insensitively) with another
// of the caller's tags, the two merge onto the existing one rather than hitting the
// unique(user_id, name) constraint.
tagsRouter.patch('/:id', async (req, res) => {
  const userId = req.userId as number;
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(422).json({ error: 'validation', fields: { id: 'invalid' } });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const raw = body.name;
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (typeof raw !== 'string' || name.length < 1 || name.length > 64) {
    res.status(422).json({ error: 'validation', fields: { name: 'invalid' } });
    return;
  }

  const result = await db.transaction(async (trx) => {
    // 1. Load the target tag (scoped to the user).
    const target = (await trx('tags').where({ id, user_id: userId }).first('id', 'name')) as
      { id: number; name: string } | undefined;
    if (!target) {
      return { notFound: true as const };
    }

    // 2. Look for a DIFFERENT existing tag of the caller's whose name matches case-insensitively,
    //    matching the _ai_ci unique(user_id, name) constraint (which a plain rename would trip).
    const collision = (await trx('tags')
      .where({ user_id: userId })
      .whereRaw('LOWER(name) = ?', [name.toLowerCase()])
      .whereNot('id', id)
      .first('id')) as { id: number } | undefined;

    let survivingId = id;

    if (!collision) {
      // 3. No collision → straight rename (also normalises the stored casing).
      await trx('tags').where({ id, user_id: userId }).update({ name });
    } else {
      // 4. Collision → merge the old (target) tag's links onto the surviving tag, then drop the
      //    old tag. Re-point only the links whose project is NOT already on the survivor so the
      //    (project_id, tag_id) primary key is never violated; the duplicates are deleted instead.
      survivingId = Number(collision.id);

      const survivorLinks = (await trx('project_tags')
        .where('tag_id', survivingId)
        .select('project_id')) as Array<{ project_id: number }>;
      const survivorProjectIds = new Set(survivorLinks.map((r) => Number(r.project_id)));

      const oldLinks = (await trx('project_tags')
        .where('tag_id', id)
        .select('project_id')) as Array<{ project_id: number }>;

      const toDelete: number[] = [];
      const toMove: number[] = [];
      for (const link of oldLinks) {
        const projectId = Number(link.project_id);
        if (survivorProjectIds.has(projectId)) toDelete.push(projectId);
        else toMove.push(projectId);
      }

      if (toDelete.length > 0) {
        await trx('project_tags').where('tag_id', id).whereIn('project_id', toDelete).delete();
      }
      if (toMove.length > 0) {
        await trx('project_tags')
          .where('tag_id', id)
          .whereIn('project_id', toMove)
          .update({ tag_id: survivingId });
      }

      await trx('tags').where({ id, user_id: userId }).delete();
    }

    // 5. Re-query the surviving tag with a refreshed usage count.
    const survivor = (await tagCountQuery(trx, userId).where('tags.id', survivingId).first()) as
      RawTagRow | undefined;
    return { tag: survivor };
  });

  if ('notFound' in result) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json(result.tag ? mapTagRow(result.tag) : null);
});

// DELETE /api/tags/:id — remove a tag label from the caller's set. Unlinks it from every project
// first, then deletes the tag row. This is label cleanup (the projects themselves are never
// touched), not a user-data hard delete.
tagsRouter.delete('/:id', async (req, res) => {
  const userId = req.userId as number;
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const deleted = await db.transaction(async (trx) => {
    const target = (await trx('tags').where({ id, user_id: userId }).first('id')) as
      { id: number } | undefined;
    if (!target) return false;

    // Remove the join rows first so the tag delete never trips the project_tags FK.
    await trx('project_tags').where('tag_id', id).delete();
    await trx('tags').where({ id, user_id: userId }).delete();
    return true;
  });

  if (!deleted) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.status(204).end();
});
