import { Router } from 'express';
import type { Knex } from 'knex';
import { db } from '../db/index.js';
import { assertProjectOwned } from '../domain/ownership.js';

// Two routers: the nested one is mounted alongside projectsRouter at /api/projects and owns
// the `/:id/notes` paths; the flat one is mounted at /api/notes and owns single-note
// PATCH/DELETE. Both go behind requireAuth in app.ts.
export const projectNotesRouter = Router();
export const notesRouter = Router();

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

// notes row as returned by noteSelect. `body_md` is RAW Markdown, stored and returned
// byte-for-byte — no parsing, stripping, or HTML-escaping here (safe rendering is the client's
// job, §3). `created_at`/`updated_at` are real timestamps, so they are returned raw (unlike the
// DATE columns the sibling routes DATE_FORMAT into YYYY-MM-DD strings).
interface NoteRow {
  id: number;
  project_id: number;
  title: string;
  body_md: string;
  created_at: Date;
  updated_at: Date;
}

// Base select: every column, timestamps included as-is.
function noteSelect(executor: Knex | Knex.Transaction) {
  return executor('notes').select<NoteRow[]>(
    'id',
    'project_id',
    'title',
    'body_md',
    'created_at',
    'updated_at',
  );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Authoritative cap on a note body: 1 MiB of UTF-8 bytes. Kept here (not at the body-parser
// layer, which is deliberately set wider to leave room for the JSON envelope) so the real limit
// lives in exactly one place and reports a 413 with a structured error.
const MAX_BODY_BYTES = 1_048_576;

function hasOwn(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

// DB-column values produced by a valid request. On PATCH only provided keys are set.
interface ValidatedNoteColumns {
  title?: string;
  body_md?: string;
}

// Mirrors the sibling routes' result shape. `tooLarge` flags the one case that maps to 413
// (payload_too_large) instead of the usual 422 (validation) — the field map is still returned so
// the client sees which field overflowed.
type NoteValidationResult =
  | { ok: true; value: ValidatedNoteColumns }
  | { ok: false; fields: Record<string, string>; tooLarge?: boolean };

/**
 * Validate a create (partial=false) or update (partial=true) request body. On PATCH only
 * provided fields are validated. `title` is a NOT-NULL column and is required on create; it must
 * be a non-empty string of 1–255 characters after trimming (whitespace-only is rejected).
 * `body_md` is optional (defaults to '' on create), must be a string, and is capped at
 * MAX_BODY_BYTES — an oversize body is reported as `tooLarge` so the route can answer 413. The
 * body is stored verbatim: no Markdown parsing, stripping, or HTML-escaping happens here.
 */
function validateNoteInput(
  body: Record<string, unknown>,
  partial: boolean,
): NoteValidationResult {
  const fields: Record<string, string> = {};
  const columns: ValidatedNoteColumns = {};
  let tooLarge = false;
  const provided = (key: string) => (partial ? hasOwn(body, key) : true);

  // title (required, 1–255 chars after trim) -----------------------------
  if (provided('title')) {
    const raw = body.title;
    if (typeof raw !== 'string') {
      fields.title = 'invalid';
    } else {
      const trimmed = raw.trim();
      if (trimmed === '' || trimmed.length > 255) {
        fields.title = 'invalid';
      } else {
        columns.title = trimmed;
      }
    }
  }

  // body_md (optional; verbatim; NOT-NULL column, defaults to '') ---------
  if (provided('body_md')) {
    const raw = body.body_md;
    if (raw === undefined) {
      // Omitted on create → fall back to the column default. Not reachable on PATCH, where
      // provided() requires the key to be present.
      columns.body_md = '';
    } else if (typeof raw !== 'string') {
      fields.body_md = 'invalid';
    } else if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
      fields.body_md = 'too_long';
      tooLarge = true;
    } else {
      // Stored exactly as sent — control chars, `<script>`, Markdown tables and all.
      columns.body_md = raw;
    }
  }

  if (Object.keys(fields).length > 0) {
    return { ok: false, fields, tooLarge };
  }
  return { ok: true, value: columns };
}

// Parse a :id route param to a positive integer, or null when it is not one (→ 404).
function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

// ---------------------------------------------------------------------------
// Nested routes: /api/projects/:id/notes  (mounted alongside projectsRouter)
// ---------------------------------------------------------------------------

// GET /api/projects/:id/notes — the whole journal for an owned project, newest-touched first.
// `body_md` is included: notes are read as a set, not lazily like a paginated feed.
projectNotesRouter.get('/:id/notes', async (req, res) => {
  const userId = req.userId as number;
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const project = await assertProjectOwned(userId, id);
  if (!project) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  // Most-recently-updated first; id as a stable tiebreak when timestamps collide.
  const rows = await noteSelect(db)
    .where('project_id', id)
    .orderBy('updated_at', 'desc')
    .orderBy('id', 'desc');
  res.json(rows);
});

// POST /api/projects/:id/notes — create a note on an owned project.
projectNotesRouter.post('/:id/notes', async (req, res) => {
  const userId = req.userId as number;
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const project = await assertProjectOwned(userId, id);
  if (!project) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = validateNoteInput(body, false);
  if (!result.ok) {
    if (result.tooLarge) {
      res.status(413).json({ error: 'payload_too_large', fields: result.fields });
    } else {
      res.status(422).json({ error: 'validation', fields: result.fields });
    }
    return;
  }

  // created_at/updated_at are set explicitly (not left to the column default) so a fresh note's
  // two timestamps come from the same now() and stay in lockstep.
  const [noteId] = await db('notes').insert({
    project_id: id,
    title: result.value.title,
    body_md: result.value.body_md ?? '',
    created_at: db.fn.now(),
    updated_at: db.fn.now(),
  });

  const created = await noteSelect(db).where('id', Number(noteId)).first();
  res.status(201).json(created);
});

// ---------------------------------------------------------------------------
// Flat routes: /api/notes/:id  (ownership via join to projects)
// ---------------------------------------------------------------------------

// Confirm a note belongs to an owned, non-soft-deleted project. Returns the note id or
// undefined (→ 404). Reads and writes on a soft-deleted project both 404.
async function findOwnedNoteId(
  userId: number,
  noteId: number,
): Promise<number | undefined> {
  const row = await db('notes as n')
    .join('projects as p', 'p.id', 'n.project_id')
    .where('n.id', noteId)
    .andWhere('p.user_id', userId)
    .whereNull('p.deleted_at')
    .first('n.id as id');
  return row ? Number((row as { id: number }).id) : undefined;
}

// GET /api/notes — the whole journal across every one of the user's non-soft-deleted projects,
// each row carrying its project's name for client-side grouping (the standalone Notes screen,
// §22). Ownership and the deleted_at filter ride the same `notes as n` → `projects as p` join as
// findOwnedNoteId. `noteSelect` can't be reused here: its column list is unqualified and would be
// ambiguous across the join, so the select is written inline with `n.`-qualified columns plus
// `p.name`. Timestamps are returned raw (ISO), exactly like GET /:id/notes — no DATE_FORMAT.
// Deliberately unpaginated: v1 returns the full journal in one shot.
notesRouter.get('/', async (req, res) => {
  const userId = req.userId as number;

  const rows = await db('notes as n')
    .join('projects as p', 'p.id', 'n.project_id')
    .where('p.user_id', userId)
    .whereNull('p.deleted_at')
    .select<(NoteRow & { project_name: string })[]>(
      'n.id',
      'n.project_id',
      'n.title',
      'n.body_md',
      'n.created_at',
      'n.updated_at',
      'p.name as project_name',
    )
    // Grouped by project name, then most-recently-updated first, id as a stable tiebreak.
    .orderBy('p.name', 'asc')
    .orderBy('n.updated_at', 'desc')
    .orderBy('n.id', 'desc');
  res.json(rows);
});

// PATCH /api/notes/:id — partial update of title and/or body_md; ownership flows through the
// project. `updated_at` is bumped whenever a field actually changes; an empty patch touches
// nothing (created_at and updated_at both stay put).
notesRouter.patch('/:id', async (req, res) => {
  const userId = req.userId as number;
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const ownedId = await findOwnedNoteId(userId, id);
  if (ownedId === undefined) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = validateNoteInput(body, true);
  if (!result.ok) {
    if (result.tooLarge) {
      res.status(413).json({ error: 'payload_too_large', fields: result.fields });
    } else {
      res.status(422).json({ error: 'validation', fields: result.fields });
    }
    return;
  }

  // Empty patch: nothing provided, so leave the row (and its updated_at) untouched.
  if (Object.keys(result.value).length > 0) {
    await db('notes')
      .where('id', id)
      .update({ ...result.value, updated_at: db.fn.now() });
  }

  const updated = await noteSelect(db).where('id', id).first();
  res.json(updated);
});

// DELETE /api/notes/:id — HARD delete, unlike projects. A note is a user-authored document the
// user explicitly chooses to remove; soft-delete protects project history, not notes.
notesRouter.delete('/:id', async (req, res) => {
  const userId = req.userId as number;
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const ownedId = await findOwnedNoteId(userId, id);
  if (ownedId === undefined) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  await db('notes').where('id', id).del();
  res.status(204).end();
});
