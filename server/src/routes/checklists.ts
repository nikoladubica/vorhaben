import { Router } from 'express';
import type { Knex } from 'knex';
import { db } from '../db/index.js';
import { assertProjectOwned } from '../domain/ownership.js';

// Checklists + their items (§ voice-capture, step 5). Two routers behind requireAuth in app.ts:
// checklistsRouter owns /api/checklists (collection + single checklist), checklistItemsRouter owns
// /api/checklist-items/:id (the check/uncheck endpoint). Every row is scoped by req.userId; a
// checklist may be filed against a project (project_id) or left unassigned (null). Soft-delete
// only. Items have no user_id/deleted_at of their own — ownership and lifecycle flow through the
// parent checklist.
export const checklistsRouter = Router();
export const checklistItemsRouter = Router();

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface ChecklistRow {
  id: number;
  project_id: number | null;
  title: string;
  source_transcript: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ItemRow {
  id: number;
  checklist_id: number;
  text: string;
  checked: number; // tinyint 0/1 from MariaDB
  position: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

// Shape a checklist + its items for the API. `checked` is coerced from tinyint to a real boolean;
// checked/total counts are derived so the client can render "n of m" without a second query.
function toChecklist(row: ChecklistRow, items: ItemRow[]) {
  const shaped = items.map((i) => ({
    id: i.id,
    text: i.text,
    checked: Number(i.checked) === 1,
    position: i.position,
  }));
  return {
    id: row.id,
    project_id: row.project_id,
    title: row.title,
    source_transcript: row.source_transcript,
    created_at: row.created_at,
    updated_at: row.updated_at,
    items: shaped,
    item_count: shaped.length,
    checked_count: shaped.filter((i) => i.checked).length,
  };
}

function checklistSelect(executor: Knex | Knex.Transaction) {
  return executor('checklists').select<ChecklistRow[]>(
    'id',
    'project_id',
    'title',
    'source_transcript',
    'created_at',
    'updated_at',
  );
}

// Load a checklist's items ordered by position (then id as a stable tiebreak).
async function loadItems(
  executor: Knex | Knex.Transaction,
  checklistIds: number[],
): Promise<Map<number, ItemRow[]>> {
  const map = new Map<number, ItemRow[]>();
  if (checklistIds.length === 0) return map;
  const rows = (await executor('checklist_items')
    .whereIn('checklist_id', checklistIds)
    .orderBy('position', 'asc')
    .orderBy('id', 'asc')
    .select('id', 'checklist_id', 'text', 'checked', 'position')) as ItemRow[];
  for (const r of rows) {
    const list = map.get(r.checklist_id) ?? [];
    list.push(r);
    map.set(r.checklist_id, list);
  }
  return map;
}

function hasOwn(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

// Validate an optional project_id body field. Returns { ok, value } where value is number|null, or
// an error code. A provided project_id must be a positive integer owned by the user; null/absent
// leaves the checklist unassigned. Ownership is checked against the same non-deleted-project rule
// as everywhere else.
async function resolveProjectId(
  userId: number,
  raw: unknown,
): Promise<{ ok: true; value: number | null } | { ok: false }> {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) return { ok: false };
  const owned = await assertProjectOwned(userId, raw);
  return owned ? { ok: true, value: raw } : { ok: false };
}

// ---------------------------------------------------------------------------
// Collection routes: /api/checklists
// ---------------------------------------------------------------------------

// POST /api/checklists — create a checklist and its items atomically. positions are the array
// order. Rejects an empty (or non-array) items list and any blank item text with 422.
checklistsRouter.post('/', async (req, res) => {
  const userId = req.userId as number;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fields: Record<string, string> = {};

  // title (required, 1–255 after trim)
  let title = '';
  if (typeof body.title !== 'string' || body.title.trim() === '' || body.title.trim().length > 255) {
    fields.title = 'invalid';
  } else {
    title = body.title.trim();
  }

  // items (required, non-empty; each { text } 1–255 after trim)
  const items: string[] = [];
  if (!Array.isArray(body.items) || body.items.length === 0) {
    fields.items = 'required';
  } else {
    for (const entry of body.items) {
      const text = (entry as { text?: unknown } | null)?.text;
      if (typeof text !== 'string' || text.trim() === '' || text.trim().length > 255) {
        fields.items = 'invalid';
        break;
      }
      items.push(text.trim());
    }
  }

  // source_transcript (optional, ≤10000)
  let sourceTranscript: string | null = null;
  if (hasOwn(body, 'source_transcript') && body.source_transcript !== null) {
    if (typeof body.source_transcript !== 'string' || body.source_transcript.length > 10_000) {
      fields.source_transcript = 'invalid';
    } else {
      sourceTranscript = body.source_transcript;
    }
  }

  // project_id (optional, nullable, must be owned)
  const project = await resolveProjectId(userId, body.project_id);
  if (!project.ok) fields.project_id = 'unknown';

  if (Object.keys(fields).length > 0) {
    res.status(422).json({ error: 'validation', fields });
    return;
  }

  const created = await db.transaction(async (trx) => {
    const [id] = await trx('checklists').insert({
      user_id: userId,
      project_id: (project as { value: number | null }).value,
      title,
      source_transcript: sourceTranscript,
      created_at: trx.fn.now(),
      updated_at: trx.fn.now(),
    });
    const checklistId = Number(id);
    await trx('checklist_items').insert(
      items.map((text, index) => ({
        checklist_id: checklistId,
        text,
        checked: false,
        position: index,
      })),
    );
    const row = await checklistSelect(trx).where('id', checklistId).first();
    const itemsMap = await loadItems(trx, [checklistId]);
    return toChecklist(row as ChecklistRow, itemsMap.get(checklistId) ?? []);
  });

  res.status(201).json(created);
});

// GET /api/checklists?project_id= — the user's live checklists (optionally scoped to one project),
// newest first, each with its items and checked/total counts.
checklistsRouter.get('/', async (req, res) => {
  const userId = req.userId as number;

  const query = checklistSelect(db).where('user_id', userId).whereNull('deleted_at');
  const { project_id } = req.query;
  if (typeof project_id === 'string' && project_id !== '') {
    const pid = Number(project_id);
    if (Number.isInteger(pid)) query.andWhere('project_id', pid);
  }
  const rows = (await query.orderBy('created_at', 'desc').orderBy('id', 'desc')) as ChecklistRow[];

  const itemsMap = await loadItems(
    db,
    rows.map((r) => r.id),
  );
  res.json(rows.map((r) => toChecklist(r, itemsMap.get(r.id) ?? [])));
});

// PATCH /api/checklists/:id — update title and/or project_id (project_id may be set to null to
// unassign). Only provided fields change; updated_at bumps on any change.
checklistsRouter.patch('/:id', async (req, res) => {
  const userId = req.userId as number;
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const existing = await db('checklists')
    .where({ id, user_id: userId })
    .whereNull('deleted_at')
    .first('id');
  if (!existing) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const fields: Record<string, string> = {};
  const update: Record<string, unknown> = {};

  if (hasOwn(body, 'title')) {
    if (typeof body.title !== 'string' || body.title.trim() === '' || body.title.trim().length > 255) {
      fields.title = 'invalid';
    } else {
      update.title = body.title.trim();
    }
  }
  if (hasOwn(body, 'project_id')) {
    const project = await resolveProjectId(userId, body.project_id);
    if (!project.ok) fields.project_id = 'unknown';
    else update.project_id = project.value;
  }

  if (Object.keys(fields).length > 0) {
    res.status(422).json({ error: 'validation', fields });
    return;
  }

  if (Object.keys(update).length > 0) {
    await db('checklists')
      .where({ id, user_id: userId })
      .update({ ...update, updated_at: db.fn.now() });
  }

  const row = await checklistSelect(db).where('id', id).first();
  const itemsMap = await loadItems(db, [id]);
  res.json(toChecklist(row as ChecklistRow, itemsMap.get(id) ?? []));
});

// DELETE /api/checklists/:id — soft delete. Never a SQL DELETE.
checklistsRouter.delete('/:id', async (req, res) => {
  const userId = req.userId as number;
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const affected = await db('checklists')
    .where({ id, user_id: userId })
    .whereNull('deleted_at')
    .update({ deleted_at: db.fn.now() });
  if (affected === 0) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Item routes: /api/checklist-items/:id
// ---------------------------------------------------------------------------

// Confirm an item belongs to one of the user's live (non-deleted) checklists. Returns the item id
// or undefined (→ 404).
async function findOwnedItemId(userId: number, itemId: number): Promise<number | undefined> {
  const row = await db('checklist_items as ci')
    .join('checklists as c', 'c.id', 'ci.checklist_id')
    .where('ci.id', itemId)
    .andWhere('c.user_id', userId)
    .whereNull('c.deleted_at')
    .first('ci.id as id');
  return row ? Number((row as { id: number }).id) : undefined;
}

// PATCH /api/checklist-items/:id — the check/uncheck (and rename) endpoint. { checked?, text? }.
checklistItemsRouter.patch('/:id', async (req, res) => {
  const userId = req.userId as number;
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const ownedId = await findOwnedItemId(userId, id);
  if (ownedId === undefined) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const fields: Record<string, string> = {};
  const update: Record<string, unknown> = {};

  if (hasOwn(body, 'checked')) {
    if (typeof body.checked !== 'boolean') fields.checked = 'invalid';
    else update.checked = body.checked;
  }
  if (hasOwn(body, 'text')) {
    if (typeof body.text !== 'string' || body.text.trim() === '' || body.text.trim().length > 255) {
      fields.text = 'invalid';
    } else {
      update.text = body.text.trim();
    }
  }

  if (Object.keys(fields).length > 0) {
    res.status(422).json({ error: 'validation', fields });
    return;
  }

  if (Object.keys(update).length > 0) {
    await db('checklist_items')
      .where('id', id)
      .update({ ...update, updated_at: db.fn.now() });
  }

  const item = (await db('checklist_items')
    .where('id', id)
    .first('id', 'checklist_id', 'text', 'checked', 'position')) as ItemRow;
  res.json({
    id: item.id,
    checklist_id: item.checklist_id,
    text: item.text,
    checked: Number(item.checked) === 1,
    position: item.position,
  });
});
