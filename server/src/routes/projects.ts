import { Router } from 'express';
import type { Knex } from 'knex';
import { db } from '../db/index.js';
import {
  COMPENSATION_MODELS,
  type CompensationModel,
  type ProjectStatus,
} from '../domain/constants.js';
import {
  deriveStatus,
  flagFromStatus,
  type StatusFlag,
} from '../domain/projectStatus.js';
import { syncProjectTags } from '../db/tags.js';
import { computeMetricsForUser } from '../domain/metrics.js';

export const projectsRouter = Router();

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

// Raw projects row as stored (start_date/end_date are formatted to YYYY-MM-DD in the
// SELECT, so they arrive as strings here rather than JS Date objects).
interface ProjectRow {
  id: number;
  user_id: number;
  name: string;
  type: string;
  description: string | null;
  status: string;
  start_date: string;
  end_date: string | null;
  compensation_model: string;
  rate_amount: string | null;
  rate_currency: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

// A ProjectRow plus the aggregated GROUP_CONCAT of tag names (unit-separator joined).
type ProjectRowWithTags = ProjectRow & { tag_names: string | null };

// Tag names are joined with the ASCII unit separator (0x1f), which cannot appear in a
// tag name, so splitting is unambiguous even if a tag contains a comma.
const TAG_SEP = '\x1f';

function mapProjectRow(row: ProjectRowWithTags) {
  const { tag_names, ...rest } = row;
  return {
    ...rest,
    tags: tag_names ? tag_names.split(TAG_SEP) : [],
  };
}

// Base query: one project row with its tags aggregated in a single query (no N+1),
// dates formatted to YYYY-MM-DD strings. `executor` may be the db or a transaction.
function projectQuery(executor: Knex | Knex.Transaction) {
  return executor('projects as p')
    .leftJoin('project_tags as pt', 'pt.project_id', 'p.id')
    .leftJoin('tags as t', 't.id', 'pt.tag_id')
    .groupBy('p.id')
    .select<ProjectRowWithTags[]>(
      'p.id',
      'p.user_id',
      'p.name',
      'p.type',
      'p.description',
      'p.status',
      executor.raw("DATE_FORMAT(p.start_date, '%Y-%m-%d') as start_date"),
      executor.raw("DATE_FORMAT(p.end_date, '%Y-%m-%d') as end_date"),
      'p.compensation_model',
      'p.rate_amount',
      'p.rate_currency',
      'p.created_at',
      'p.updated_at',
      'p.deleted_at',
      // SEPARATOR takes a string literal (not an expression like CHAR(31)), so embed the
      // unit-separator byte directly. TAG_SEP is a fixed constant — no injection surface.
      executor.raw(
        `GROUP_CONCAT(t.name ORDER BY t.name SEPARATOR '${TAG_SEP}') as tag_names`,
      ),
    );
}

// Fetch a single owned, non-deleted project with its tags. Returns undefined if missing.
async function fetchOwnedProject(
  executor: Knex | Knex.Transaction,
  userId: number,
  id: number,
) {
  const row = await projectQuery(executor)
    .where('p.id', id)
    .andWhere('p.user_id', userId)
    .whereNull('p.deleted_at')
    .first();
  return row ? mapProjectRow(row as ProjectRowWithTags) : undefined;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  // Reject impossible calendar dates (e.g. 2026-02-30) that Date would roll over.
  return date.toISOString().slice(0, 10) === value;
}

// The DB-column values produced by a valid request. Only keys that were provided are set
// (so a PATCH updates just those columns).
interface ValidatedColumns {
  name?: string;
  type?: string;
  description?: string | null;
  compensation_model?: CompensationModel;
  start_date?: string;
  end_date?: string | null;
  rate_amount?: number | null;
  rate_currency?: string | null;
}

interface ValidatedInput {
  columns: ValidatedColumns;
  statusFlag: StatusFlag;
  effectiveStart: string;
  effectiveEnd: string | null;
  tagsProvided: boolean;
  tags: string[];
}

type ValidationResult =
  | { ok: true; value: ValidatedInput }
  | { ok: false; fields: Record<string, string> };

function hasOwn(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

/**
 * Validate a create (partial=false) or update (partial=true) request body.
 * On PATCH only provided fields are validated; cross-field checks use the effective
 * value (incoming if provided, else the stored `existing` row).
 */
async function validateProjectInput(
  body: Record<string, unknown>,
  userId: number,
  partial: boolean,
  existing?: ReturnType<typeof mapProjectRow>,
): Promise<ValidationResult> {
  const fields: Record<string, string> = {};
  const columns: ValidatedColumns = {};

  const provided = (key: string) => (partial ? hasOwn(body, key) : true);

  // name -----------------------------------------------------------------
  if (provided('name')) {
    const raw = body.name;
    if (typeof raw !== 'string' || raw.trim().length < 1) {
      fields.name = 'required';
    } else if (raw.trim().length > 255) {
      fields.name = 'too_long';
    } else {
      columns.name = raw.trim();
    }
  }

  // type ------------------------------------------------------------------
  if (provided('type')) {
    const raw = body.type;
    if (typeof raw !== 'string' || raw.length === 0) {
      fields.type = 'required';
    } else {
      const match = await db('project_types').where({ id: raw }).first('id');
      if (!match) fields.type = 'unknown';
      else columns.type = raw;
    }
  }

  // description (optional free text) --------------------------------------
  if (provided('description')) {
    const raw = body.description;
    if (raw === null || raw === undefined) {
      columns.description = null;
    } else if (typeof raw !== 'string') {
      fields.description = 'invalid';
    } else {
      columns.description = raw;
    }
  }

  // compensation_model ----------------------------------------------------
  if (provided('compensation_model')) {
    const raw = body.compensation_model;
    if (
      typeof raw !== 'string' ||
      !COMPENSATION_MODELS.includes(raw as CompensationModel)
    ) {
      fields.compensation_model = 'invalid';
    } else {
      columns.compensation_model = raw as CompensationModel;
    }
  }

  // start_date ------------------------------------------------------------
  if (provided('start_date')) {
    const raw = body.start_date;
    if (typeof raw !== 'string' || !isValidDate(raw)) {
      fields.start_date = 'invalid';
    } else {
      columns.start_date = raw;
    }
  }

  // end_date --------------------------------------------------------------
  if (provided('end_date')) {
    const raw = body.end_date;
    if (raw === null || raw === undefined) {
      columns.end_date = null;
    } else if (typeof raw !== 'string' || !isValidDate(raw)) {
      fields.end_date = 'invalid';
    } else {
      columns.end_date = raw;
    }
  }

  // status (manual intent; `ended` never accepted) -----------------------
  let statusFlag: StatusFlag = null;
  let statusProvided = false;
  if (hasOwn(body, 'status')) {
    statusProvided = true;
    const raw = body.status;
    if (raw === 'active') {
      statusFlag = null;
    } else if (raw === 'paused' || raw === 'idea') {
      statusFlag = raw;
    } else {
      fields.status = 'invalid';
    }
  }

  // rate_amount -----------------------------------------------------------
  if (provided('rate_amount')) {
    const raw = body.rate_amount;
    if (raw === null || raw === undefined) {
      columns.rate_amount = null;
    } else if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
      fields.rate_amount = 'invalid';
    } else {
      columns.rate_amount = raw;
    }
  }

  // rate_currency ---------------------------------------------------------
  if (provided('rate_currency')) {
    const raw = body.rate_currency;
    if (raw === null || raw === undefined) {
      columns.rate_currency = null;
    } else if (typeof raw !== 'string' || !CURRENCY_RE.test(raw)) {
      fields.rate_currency = 'invalid';
    } else {
      columns.rate_currency = raw;
    }
  }

  // tags (optional on both create and update; absent → leave tags untouched) ---
  let tagsProvided = false;
  let tags: string[] = [];
  if (hasOwn(body, 'tags')) {
    tagsProvided = true;
    const raw = body.tags;
    if (!Array.isArray(raw)) {
      fields.tags = 'invalid';
    } else {
      const seen = new Set<string>();
      let bad = false;
      for (const entry of raw) {
        if (typeof entry !== 'string') {
          bad = true;
          break;
        }
        const trimmed = entry.trim();
        if (trimmed.length < 1 || trimmed.length > 64) {
          bad = true;
          break;
        }
        // Dedupe case-insensitively, keeping the first-seen casing.
        const key = trimmed.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          tags.push(trimmed);
        }
      }
      if (bad) {
        fields.tags = 'invalid';
        tags = [];
      }
    }
  }

  // Cross-field: end_date >= start_date, using effective values.
  const effectiveStart = columns.start_date ?? existing?.start_date ?? '';
  const effectiveEnd =
    columns.end_date !== undefined ? columns.end_date : (existing?.end_date ?? null);

  if (
    !fields.start_date &&
    !fields.end_date &&
    effectiveEnd !== null &&
    effectiveStart !== '' &&
    effectiveEnd < effectiveStart
  ) {
    fields.end_date = 'before_start';
  }

  if (Object.keys(fields).length > 0) {
    return { ok: false, fields };
  }

  // Resolve the manual status flag: explicit status wins; otherwise on PATCH recover the
  // stored intent, on create default to null.
  const resolvedFlag: StatusFlag = statusProvided
    ? statusFlag
    : existing
      ? flagFromStatus(existing.status as ProjectStatus)
      : null;

  return {
    ok: true,
    value: {
      columns,
      statusFlag: resolvedFlag,
      effectiveStart,
      effectiveEnd,
      tagsProvided,
      tags,
    },
  };
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

// Round a display money figure to 2dp; null (no data) passes through untouched. Mirrors the
// dashboard's edge-rounding rule — the normalization layer keeps full precision, the API rounds.
function roundMoney(value: number | null): number | null {
  if (value === null) return null;
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Routes (mounted behind requireAuth; every query scoped to req.userId)
// ---------------------------------------------------------------------------

// GET /api/projects — list owned, non-deleted projects with optional filters.
projectsRouter.get('/', async (req, res) => {
  const userId = req.userId as number;
  const { status, type, tag } = req.query;

  const query = projectQuery(db)
    .where('p.user_id', userId)
    .whereNull('p.deleted_at');

  if (typeof status === 'string' && status !== '') {
    query.andWhere('p.status', status);
  }
  if (typeof type === 'string' && type !== '') {
    query.andWhere('p.type', type);
  }
  if (typeof tag === 'string' && tag !== '') {
    // Filter to projects carrying this tag without collapsing the aggregated tag list.
    query.whereExists(function () {
      this.select(db.raw('1'))
        .from('project_tags as ptf')
        .join('tags as tf', 'tf.id', 'ptf.tag_id')
        .whereRaw('ptf.project_id = p.id')
        .andWhere('tf.name', tag);
    });
  }

  // Active projects first, then most-recently updated.
  query.orderByRaw("(p.status = 'active') desc").orderBy('p.updated_at', 'desc');

  const rows = (await query) as ProjectRowWithTags[];
  res.json(rows.map(mapProjectRow));
});

// POST /api/projects — create.
projectsRouter.post('/', async (req, res) => {
  const userId = req.userId as number;
  const body = (req.body ?? {}) as Record<string, unknown>;

  const result = await validateProjectInput(body, userId, false);
  if (!result.ok) {
    res.status(422).json({ error: 'validation', fields: result.fields });
    return;
  }

  const { columns, statusFlag, effectiveStart, effectiveEnd, tags } = result.value;
  const status = deriveStatus({
    status_flag: statusFlag,
    start_date: effectiveStart,
    end_date: effectiveEnd,
    today: todayString(),
  });

  const created = await db.transaction(async (trx) => {
    const [id] = await trx('projects').insert({
      user_id: userId,
      name: columns.name,
      type: columns.type,
      description: columns.description ?? null,
      status,
      start_date: columns.start_date,
      end_date: columns.end_date ?? null,
      compensation_model: columns.compensation_model,
      rate_amount: columns.rate_amount ?? null,
      rate_currency: columns.rate_currency ?? null,
    });
    const projectId = Number(id);
    await syncProjectTags(trx, userId, projectId, tags);
    return fetchOwnedProject(trx, userId, projectId);
  });

  res.status(201).json(created);
});

// GET /api/projects/:id — single project.
projectsRouter.get('/:id', async (req, res) => {
  const userId = req.userId as number;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const project = await fetchOwnedProject(db, userId, id);
  if (!project) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json(project);
});

// GET /api/projects/:id/metrics — the single project's normalized headline figures, drawn from
// the SAME canonical trailing-3-month window as the dashboard (computeMetricsForUser is the one
// normalization entry point — we never call the pure layer directly). Powers the detail screen's
// revenue / expenses / net summary. `/:id` above is a single segment, so it never captures this
// two-segment path regardless of route order. Money figures are rounded to 2dp for display, in
// the user's base currency; nulls (no contributing entries / no logged hours) pass through.
projectsRouter.get('/:id/metrics', async (req, res) => {
  const userId = req.userId as number;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  // Ownership + existence check (also 404s a soft-deleted project) before any computation.
  const project = await fetchOwnedProject(db, userId, id);
  if (!project) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const user = await db('users').where('id', userId).first('base_currency');
  const baseCurrency = (user as { base_currency: string } | undefined)?.base_currency ?? 'EUR';

  const metrics = await computeMetricsForUser(userId);
  const m = metrics.get(id);

  res.json({
    project_id: id,
    base_currency: baseCurrency,
    total_revenue: roundMoney(m?.totalRevenue ?? null),
    monthly_revenue: roundMoney(m?.monthlyRevenue ?? null),
    monthly_expenses: roundMoney(m?.monthlyExpenses ?? null),
    monthly_net: roundMoney(m?.monthlyNet ?? null),
    effective_hourly_rate: roundMoney(m?.effectiveHourlyRate ?? null),
    hours_in_window: m?.hoursInWindow ?? 0,
  });
});

// PATCH /api/projects/:id — partial update.
projectsRouter.patch('/:id', async (req, res) => {
  const userId = req.userId as number;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const existing = await fetchOwnedProject(db, userId, id);
  if (!existing) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = await validateProjectInput(body, userId, true, existing);
  if (!result.ok) {
    res.status(422).json({ error: 'validation', fields: result.fields });
    return;
  }

  const { columns, statusFlag, effectiveStart, effectiveEnd, tagsProvided, tags } =
    result.value;
  const status = deriveStatus({
    status_flag: statusFlag,
    start_date: effectiveStart,
    end_date: effectiveEnd,
    today: todayString(),
  });

  const updated = await db.transaction(async (trx) => {
    await trx('projects')
      .where({ id, user_id: userId })
      .whereNull('deleted_at')
      .update({
        ...columns,
        status,
        updated_at: trx.fn.now(),
      });
    if (tagsProvided) {
      await syncProjectTags(trx, userId, id, tags);
    }
    return fetchOwnedProject(trx, userId, id);
  });

  res.json(updated);
});

// DELETE /api/projects/:id — soft delete. Never a SQL DELETE.
projectsRouter.delete('/:id', async (req, res) => {
  const userId = req.userId as number;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const affected = await db('projects')
    .where({ id, user_id: userId })
    .whereNull('deleted_at')
    .update({ deleted_at: db.fn.now() });

  if (affected === 0) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.status(204).end();
});

// POST /api/projects/:id/restore — clear a soft delete.
projectsRouter.post('/:id/restore', async (req, res) => {
  const userId = req.userId as number;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const affected = await db('projects')
    .where({ id, user_id: userId })
    .whereNotNull('deleted_at')
    .update({ deleted_at: null, updated_at: db.fn.now() });

  if (affected === 0) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const project = await fetchOwnedProject(db, userId, id);
  res.json(project);
});
