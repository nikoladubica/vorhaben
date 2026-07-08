import type { Knex } from 'knex';

interface TagRow {
  id: number;
  name: string;
}

/**
 * Reconcile a project's tags to exactly `names` (already trimmed + deduped by the caller),
 * all within the passed transaction and scoped to `userId`.
 *
 * 1. Resolve each name to a tag id, inserting missing tags (respecting unique(user_id, name)).
 * 2. Replace the project_tags rows for this project: delete rows not in the new set, insert new ones.
 * 3. Delete now-orphaned tags owned by the user (zero remaining project_tags). This is tag
 *    bookkeeping — not a user-data hard delete — so the tags table never accumulates dangling rows.
 */
export async function syncProjectTags(
  trx: Knex.Transaction,
  userId: number,
  projectId: number,
  names: string[],
): Promise<void> {
  // 1. Resolve tag ids (select existing, insert missing).
  const tagIds = new Set<number>();
  if (names.length > 0) {
    const existing = (await trx('tags')
      .where({ user_id: userId })
      .whereIn('name', names)
      .select('id', 'name')) as TagRow[];
    // Key by lower-case: the tags.name collation is case-insensitive (utf8mb4_*_ai_ci) and
    // unique(user_id, name), so a stored 'remote' must resolve an incoming 'Remote' to the
    // same row — a case-sensitive lookup would miss and try to INSERT a duplicate.
    const idByName = new Map(existing.map((row) => [row.name.toLowerCase(), row.id]));

    for (const name of names) {
      const key = name.toLowerCase();
      let id = idByName.get(key);
      if (id === undefined) {
        const [inserted] = await trx('tags').insert({ user_id: userId, name });
        id = Number(inserted);
        idByName.set(key, id);
      }
      tagIds.add(id);
    }
  }

  // 2. Replace project_tags rows.
  const current = (await trx('project_tags')
    .where({ project_id: projectId })
    .select('tag_id')) as Array<{ tag_id: number }>;
  const currentIds = new Set(current.map((row) => row.tag_id));

  const toRemove = [...currentIds].filter((id) => !tagIds.has(id));
  const toAdd = [...tagIds].filter((id) => !currentIds.has(id));

  if (toRemove.length > 0) {
    await trx('project_tags')
      .where({ project_id: projectId })
      .whereIn('tag_id', toRemove)
      .delete();
  }
  if (toAdd.length > 0) {
    await trx('project_tags').insert(
      toAdd.map((tag_id) => ({ project_id: projectId, tag_id })),
    );
  }

  // 3. Delete now-orphaned tags. Only the just-unlinked ids can have become orphaned.
  if (toRemove.length > 0) {
    const stillUsed = (await trx('project_tags')
      .whereIn('tag_id', toRemove)
      .select('tag_id')) as Array<{ tag_id: number }>;
    const usedIds = new Set(stillUsed.map((row) => row.tag_id));
    const orphaned = toRemove.filter((id) => !usedIds.has(id));
    if (orphaned.length > 0) {
      await trx('tags').where({ user_id: userId }).whereIn('id', orphaned).delete();
    }
  }
}
