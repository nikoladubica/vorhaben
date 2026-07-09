import { Router, text as textBody, raw as rawBody } from 'express';
import type { Knex } from 'knex';
import { db } from '../db/index.js';
import {
  serializeCsv,
  parseCsv,
  isBlankRecord,
  CsvParseError,
  unescapeFormulaText,
} from '../domain/csv.js';
import { serializeXlsxWorkbook, parseXlsxSheet } from '../domain/xlsx.js';
import { COMPENSATION_MODELS, type CompensationModel } from '../domain/constants.js';
import { deriveStatus, type StatusFlag } from '../domain/projectStatus.js';

// The OOXML spreadsheet MIME — the Content-Type of a .xlsx upload and download.
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// CSV export / import (BUSINESS_LOGIC.md §8). Two routers, mirroring the codebase's split-router
// style: `exportRouter` is mounted at /api/export, `importRouter` at /api/import, both behind
// requireAuth (see app.ts). Every query is scoped to req.userId.
//
// Export is complete and lossless: every user-owned row, original amounts and currencies (never
// converted), one CSV per table, soft-deleted projects included. Import is pragmatic: projects and
// income entries only, always validated first, dry-run by default, all-or-nothing on commit.
export const exportRouter = Router();
export const importRouter = Router();

// ---------------------------------------------------------------------------
// Shared helpers
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

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

// One export table: the CSV column order (documented in the header row) and a builder that returns
// the user's rows already keyed by those columns. Timestamps are DATE_FORMAT'd in SQL to stable
// 'YYYY-MM-DD HH:MM:SS' strings; DATE columns to 'YYYY-MM-DD'; amounts/hours stay exact decimal
// strings from mysql2. Child tables (entries, logs, notes, expenses) carry BOTH project_id (for
// re-import) and project_name (for human readability), and include rows of soft-deleted projects.
interface ExportTable {
  columns: readonly string[];
  // `projectId`, when given, filters the rows to that one project (child tables only — the
  // project-less `projects`/`tags` builds ignore it, and the routes reject ?project for them).
  build: (userId: number, projectId?: number) => Promise<Array<Record<string, unknown>>>;
}

// The child tables that a ?project=<id> filter (and the per-project workbook) apply to. `projects`
// and `tags` are not project-scoped, so ?project on them is a 400.
const PROJECT_SCOPED_TABLES = new Set(['income-entries', 'expenses', 'time-logs', 'notes']);

// The SELECT expression `DATE_FORMAT(col) as alias`. The alias MUST be unqualified — Knex escapes
// `??` as an identifier, and aliasing to a table-qualified name (`` `e`.`date` ``) is invalid SQL —
// so a joined column like 'e.date' aliases to just its last segment ('date').
const alias = (col: string) => col.split('.').pop() as string;
const TS = (col: string) => db.raw("DATE_FORMAT(??, '%Y-%m-%d %H:%i:%s') as ??", [col, alias(col)]);
const DATE = (col: string) => db.raw("DATE_FORMAT(??, '%Y-%m-%d') as ??", [col, alias(col)]);

const EXPORT_TABLES: Record<string, ExportTable> = {
  projects: {
    columns: [
      'id',
      'name',
      'type',
      'description',
      'status',
      'start_date',
      'end_date',
      'compensation_model',
      'rate_amount',
      'rate_currency',
      'created_at',
      'updated_at',
      'deleted_at',
    ],
    build: (userId) =>
      db('projects')
        .where('user_id', userId)
        .orderBy('id')
        .select(
          'id',
          'name',
          'type',
          'description',
          'status',
          DATE('start_date'),
          DATE('end_date'),
          'compensation_model',
          'rate_amount',
          'rate_currency',
          TS('created_at'),
          TS('updated_at'),
          TS('deleted_at'),
        ),
  },
  'income-entries': {
    columns: [
      'id',
      'project_id',
      'project_name',
      'date',
      'amount',
      'currency',
      'note',
      'source',
      'created_at',
    ],
    build: (userId, projectId) => {
      const q = db('income_entries as e')
        .join('projects as p', 'p.id', 'e.project_id')
        .where('p.user_id', userId);
      if (projectId !== undefined) q.where('e.project_id', projectId);
      return q
        .orderBy('e.id')
        .select(
          'e.id',
          'e.project_id',
          'p.name as project_name',
          DATE('e.date'),
          'e.amount',
          'e.currency',
          'e.note',
          'e.source',
          TS('e.created_at'),
        );
    },
  },
  expenses: {
    columns: [
      'id',
      'project_id',
      'project_name',
      'date',
      'amount',
      'currency',
      'note',
      'created_at',
    ],
    build: (userId, projectId) => {
      const q = db('expense_entries as e')
        .join('projects as p', 'p.id', 'e.project_id')
        .where('p.user_id', userId);
      if (projectId !== undefined) q.where('e.project_id', projectId);
      return q
        .orderBy('e.id')
        .select(
          'e.id',
          'e.project_id',
          'p.name as project_name',
          DATE('e.date'),
          'e.amount',
          'e.currency',
          'e.note',
          TS('e.created_at'),
        );
    },
  },
  'time-logs': {
    columns: [
      'id',
      'project_id',
      'project_name',
      'date',
      'end_date',
      'hours',
      'note',
      'created_at',
    ],
    build: (userId, projectId) => {
      const q = db('time_logs as t')
        .join('projects as p', 'p.id', 't.project_id')
        .where('p.user_id', userId);
      if (projectId !== undefined) q.where('t.project_id', projectId);
      return q
        .orderBy('t.id')
        .select(
          't.id',
          't.project_id',
          'p.name as project_name',
          DATE('t.date'),
          DATE('t.end_date'),
          't.hours',
          't.note',
          TS('t.created_at'),
        );
    },
  },
  notes: {
    columns: ['id', 'project_id', 'project_name', 'title', 'body_md', 'created_at', 'updated_at'],
    build: (userId, projectId) => {
      const q = db('notes as n')
        .join('projects as p', 'p.id', 'n.project_id')
        .where('p.user_id', userId);
      if (projectId !== undefined) q.where('n.project_id', projectId);
      return q
        .orderBy('n.id')
        .select(
          'n.id',
          'n.project_id',
          'p.name as project_name',
          'n.title',
          'n.body_md',
          TS('n.created_at'),
          TS('n.updated_at'),
        );
    },
  },
  tags: {
    columns: ['id', 'name'],
    build: (userId) => db('tags').where('user_id', userId).orderBy('id').select('id', 'name'),
  },
};

// True when `projectId` is one of the caller's projects. `allowDeleted` includes soft-deleted rows
// (export wants them — losslessness); leave it false for import, which must not target a soft-deleted
// project.
async function ownsProject(
  userId: number,
  projectId: number,
  allowDeleted: boolean,
): Promise<boolean> {
  const q = db('projects').where({ id: projectId, user_id: userId });
  if (!allowDeleted) q.whereNull('deleted_at');
  const row = await q.first('id');
  return Boolean(row);
}

type FilterResult =
  | { ok: true; projectId: number | undefined }
  | { ok: false; status: number; body: { error: string; message: string } };

// Validate an optional ?project=<id> on an export. Absent → no filter. Present but the table is not
// project-scoped → 400. Present but malformed → 400. Present and well-formed but not owned → 404
// (soft-deleted projects are allowed, for lossless export).
async function resolveExportProjectFilter(
  userId: number,
  table: string,
  rawProject: unknown,
): Promise<FilterResult> {
  const raw = typeof rawProject === 'string' ? rawProject : undefined;
  if (raw === undefined || raw === '') return { ok: true, projectId: undefined };

  if (!PROJECT_SCOPED_TABLES.has(table)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'project_filter_unsupported',
        message: `?project is not valid for the "${table}" export`,
      },
    };
  }

  const projectId = Number(raw);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return {
      ok: false,
      status: 400,
      body: { error: 'invalid_project', message: 'project must be a positive integer id' },
    };
  }

  if (!(await ownsProject(userId, projectId, true))) {
    return { ok: false, status: 404, body: { error: 'not_found', message: 'project not found' } };
  }
  return { ok: true, projectId };
}

// GET /api/export/:table.csv — stream one table's rows as an attachment. The `.csv` suffix keeps
// the download named correctly and the route unambiguous; `:table` is validated against the map. An
// optional ?project=<id> narrows a child table to one owned project (see resolveExportProjectFilter).
exportRouter.get('/:table.csv', async (req, res) => {
  const userId = req.userId as number;
  const table = req.params.table;
  const spec = EXPORT_TABLES[table];
  if (!spec) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const filter = await resolveExportProjectFilter(userId, table, req.query.project);
  if (!filter.ok) {
    res.status(filter.status).json(filter.body);
    return;
  }

  const rows = await spec.build(userId, filter.projectId);
  const csv = serializeCsv(spec.columns, rows);

  const scope = filter.projectId !== undefined ? `-project-${filter.projectId}` : '';
  const filename = `vorhaben-${table}${scope}-${todayString()}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

// Send an .xlsx buffer as a download named `vorhaben-<label>-<date>.xlsx`.
function sendXlsx(res: import('express').Response, label: string, buffer: Buffer): void {
  const filename = `vorhaben-${label}-${todayString()}.xlsx`;
  res.setHeader('Content-Type', XLSX_MIME);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}

// GET /api/export/all.xlsx — one workbook, one sheet per table (sheet name = table key), same data
// as the per-table exports. XLSX-only bundling; the CSV path stays one-file-per-table. Registered
// BEFORE /:table.xlsx so the literal "all" is never treated as a (nonexistent) table. ?project is
// not meaningful for the whole-account workbook → 400.
exportRouter.get('/all.xlsx', async (req, res) => {
  const userId = req.userId as number;
  if (typeof req.query.project === 'string' && req.query.project !== '') {
    res.status(400).json({
      error: 'project_filter_unsupported',
      message: '?project is not valid for the all-tables workbook',
    });
    return;
  }
  const sheets = [];
  for (const [table, spec] of Object.entries(EXPORT_TABLES)) {
    sheets.push({ name: table, columns: spec.columns, rows: await spec.build(userId) });
  }
  const buffer = await serializeXlsxWorkbook(sheets);
  sendXlsx(res, 'all', buffer);
});

// GET /api/export/project/:id.xlsx — one workbook with the four child-table sheets filtered to a
// single owned project (soft-deleted allowed, for lossless export). 404 on unknown/non-owned. The
// two-segment path can never collide with /:table.xlsx, but register it before that route anyway.
exportRouter.get('/project/:id.xlsx', async (req, res) => {
  const userId = req.userId as number;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (!(await ownsProject(userId, id, true))) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const sheets = [];
  for (const table of PROJECT_SCOPED_TABLES) {
    const spec = EXPORT_TABLES[table];
    if (!spec) continue;
    sheets.push({ name: table, columns: spec.columns, rows: await spec.build(userId, id) });
  }
  const buffer = await serializeXlsxWorkbook(sheets);
  sendXlsx(res, `project-${id}`, buffer);
});

// GET /api/export/:table.xlsx — single-sheet workbook, parity with /:table.csv (same EXPORT_TABLES
// entry, same columns, same rows, same optional ?project filter), delivered as .xlsx.
exportRouter.get('/:table.xlsx', async (req, res) => {
  const userId = req.userId as number;
  const table = req.params.table;
  const spec = EXPORT_TABLES[table];
  if (!spec) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const filter = await resolveExportProjectFilter(userId, table, req.query.project);
  if (!filter.ok) {
    res.status(filter.status).json(filter.body);
    return;
  }

  const rows = await spec.build(userId, filter.projectId);
  const buffer = await serializeXlsxWorkbook([{ name: table, columns: spec.columns, rows }]);
  const scope = filter.projectId !== undefined ? `-project-${filter.projectId}` : '';
  sendXlsx(res, `${table}${scope}`, buffer);
});

// ---------------------------------------------------------------------------
// Import — shared machinery
// ---------------------------------------------------------------------------

interface ImportError {
  row: number;
  field: string;
  message: string;
}

// A validated, ready-to-insert row plus the dedup key that decides insert-vs-skip. `display` is the
// 1-based record position in the file (header = row 1) used in error/skip reporting.
interface PreparedRow<T> {
  display: number;
  values: T;
  dedupKey: string;
  // True when this row matches an existing DB row OR an earlier row in the same file → skipped,
  // never inserted. Decided during prepare, where the running seen-key set is authoritative.
  duplicate: boolean;
}

interface ImportReport {
  dry_run: boolean;
  valid_rows: number; // rows that passed validation (would insert OR skip)
  insert_rows: number; // valid rows that are new
  skip_rows: number; // valid rows matching an existing row → skipped
  errors: ImportError[];
}

// Map a header record to a column→index lookup, lower-cased and trimmed so a hand-edited header is
// forgiving about case and stray spaces.
function headerIndex(header: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  header.forEach((name, i) => {
    const key = name.trim().toLowerCase();
    if (!map.has(key)) map.set(key, i);
  });
  return map;
}

// Read a cell by column name; missing column or short row → '' (trimmed). Any formula-injection
// guard applied on export (a leading quote before =/+/-/@) is stripped here so an exported value
// round-trips to its exact stored form — which also lets a re-import dedup against the un-prefixed
// row. Applies uniformly to CSV and XLSX imports, since both flow through this single read point.
function cell(record: readonly string[], idx: Map<string, number>, name: string): string {
  const at = idx.get(name);
  if (at === undefined) return '';
  return unescapeFormulaText((record[at] ?? '').trim());
}

// ---------------------------------------------------------------------------
// Import — projects
// ---------------------------------------------------------------------------

interface ProjectImportValues {
  name: string;
  type: string;
  description: string | null;
  status: string;
  start_date: string;
  end_date: string | null;
  compensation_model: CompensationModel;
  rate_amount: number | null;
  rate_currency: string | null;
}

const PROJECT_REQUIRED_COLUMNS = ['name', 'type', 'compensation_model', 'start_date'];

async function prepareProjectImport(
  userId: number,
  records: string[][],
): Promise<{ prepared: PreparedRow<ProjectImportValues>[]; errors: ImportError[] }> {
  const errors: ImportError[] = [];
  const prepared: PreparedRow<ProjectImportValues>[] = [];

  const header = records[0] ?? [];
  const idx = headerIndex(header);
  for (const col of PROJECT_REQUIRED_COLUMNS) {
    if (!idx.has(col)) {
      errors.push({ row: 1, field: col, message: `missing required column "${col}"` });
    }
  }
  if (errors.length > 0) {
    return { prepared, errors };
  }

  // Valid project-type ids, loaded once.
  const typeRows = (await db('project_types').select('id')) as Array<{ id: string }>;
  const validTypes = new Set(typeRows.map((r) => r.id));

  // Existing project names (all of the user's, including soft-deleted) for idempotent re-import.
  // Names compared case-insensitively to match MariaDB's default _ci collation. Names inserted
  // earlier in THIS file are added as we go so an in-file duplicate also skips.
  const existingRows = (await db('projects').where('user_id', userId).select('name')) as Array<{
    name: string;
  }>;
  const seenNames = new Set(existingRows.map((r) => r.name.toLowerCase()));

  const today = todayString();

  for (let i = 1; i < records.length; i++) {
    const record = records[i];
    if (record === undefined || isBlankRecord(record)) continue;
    const display = i + 1;
    const rowErrors: ImportError[] = [];

    const name = cell(record, idx, 'name');
    if (name.length < 1) {
      rowErrors.push({ row: display, field: 'name', message: 'name is required' });
    } else if (name.length > 255) {
      rowErrors.push({ row: display, field: 'name', message: 'name is too long (max 255)' });
    }

    const type = cell(record, idx, 'type');
    if (type.length < 1) {
      rowErrors.push({ row: display, field: 'type', message: 'type is required' });
    } else if (!validTypes.has(type)) {
      rowErrors.push({ row: display, field: 'type', message: `unknown type "${type}"` });
    }

    const model = cell(record, idx, 'compensation_model');
    if (model.length < 1) {
      rowErrors.push({
        row: display,
        field: 'compensation_model',
        message: 'compensation_model is required',
      });
    } else if (!COMPENSATION_MODELS.includes(model as CompensationModel)) {
      rowErrors.push({
        row: display,
        field: 'compensation_model',
        message: `unknown compensation_model "${model}"`,
      });
    }

    const startDate = cell(record, idx, 'start_date');
    if (!isValidDate(startDate)) {
      rowErrors.push({
        row: display,
        field: 'start_date',
        message: `invalid start_date "${startDate}" (expected YYYY-MM-DD)`,
      });
    }

    const endRaw = cell(record, idx, 'end_date');
    let endDate: string | null = null;
    if (endRaw !== '') {
      if (!isValidDate(endRaw)) {
        rowErrors.push({
          row: display,
          field: 'end_date',
          message: `invalid end_date "${endRaw}" (expected YYYY-MM-DD)`,
        });
      } else if (isValidDate(startDate) && endRaw < startDate) {
        rowErrors.push({
          row: display,
          field: 'end_date',
          message: 'end_date is before start_date',
        });
      } else {
        endDate = endRaw;
      }
    }

    const descRaw = cell(record, idx, 'description');
    const description = descRaw === '' ? null : descRaw;

    const rateRaw = cell(record, idx, 'rate_amount');
    let rateAmount: number | null = null;
    if (rateRaw !== '') {
      const parsed = Number(rateRaw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        rowErrors.push({
          row: display,
          field: 'rate_amount',
          message: `invalid rate_amount "${rateRaw}"`,
        });
      } else {
        rateAmount = parsed;
      }
    }

    const curRaw = cell(record, idx, 'rate_currency');
    let rateCurrency: string | null = null;
    if (curRaw !== '') {
      if (!CURRENCY_RE.test(curRaw)) {
        rowErrors.push({
          row: display,
          field: 'rate_currency',
          message: `invalid rate_currency "${curRaw}" (expected 3-letter code)`,
        });
      } else {
        rateCurrency = curRaw;
      }
    }

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      continue;
    }

    // A manual status intent is honoured only for paused/idea; active/ended/blank are derived from
    // the dates (ended is never accepted as input, per projectStatus.ts).
    const statusRaw = cell(record, idx, 'status').toLowerCase();
    const flag: StatusFlag = statusRaw === 'paused' || statusRaw === 'idea' ? statusRaw : null;
    const status = deriveStatus({
      status_flag: flag,
      start_date: startDate,
      end_date: endDate,
      today,
    });

    const dedupKey = name.toLowerCase();
    const duplicate = seenNames.has(dedupKey);
    if (!duplicate) seenNames.add(dedupKey);

    prepared.push({
      display,
      dedupKey,
      duplicate,
      values: {
        name,
        type,
        description,
        status,
        start_date: startDate,
        end_date: endDate,
        compensation_model: model as CompensationModel,
        rate_amount: rateAmount,
        rate_currency: rateCurrency,
      },
    });
  }

  return { prepared, errors };
}

// ---------------------------------------------------------------------------
// Import — income entries
// ---------------------------------------------------------------------------

interface EntryImportValues {
  project_id: number;
  date: string;
  amount: number;
  currency: string;
  note: string | null;
}

const ENTRY_REQUIRED_COLUMNS = ['date', 'amount'];

async function prepareEntryImport(
  userId: number,
  records: string[][],
  // Targeted mode: when set, every row imports INTO this project. A row may omit the project columns
  // entirely (the common bare `date,amount,note` spreadsheet), and a row that DOES name a project
  // must name this same one — anything else is a per-row error, never a silent reroute. The route
  // has already verified the target is owned and not soft-deleted.
  targetProjectId?: number,
): Promise<{ prepared: PreparedRow<EntryImportValues>[]; errors: ImportError[] }> {
  const errors: ImportError[] = [];
  const prepared: PreparedRow<EntryImportValues>[] = [];
  const targeted = targetProjectId !== undefined;

  const header = records[0] ?? [];
  const idx = headerIndex(header);
  for (const col of ENTRY_REQUIRED_COLUMNS) {
    if (!idx.has(col)) {
      errors.push({ row: 1, field: col, message: `missing required column "${col}"` });
    }
  }
  // A project reference column is required only in untargeted mode; a targeted import defaults every
  // row to its target project, so a file with no project columns is the expected case.
  if (!targeted && !idx.has('project_id') && !idx.has('project_name')) {
    errors.push({
      row: 1,
      field: 'project',
      message: 'missing a project reference column (project_id or project_name)',
    });
  }
  if (errors.length > 0) {
    return { prepared, errors };
  }

  // The user's owned, non-deleted projects, indexed by id and by lower-cased name for resolution.
  const projects = (await db('projects')
    .where('user_id', userId)
    .whereNull('deleted_at')
    .select('id', 'name', 'rate_currency')) as Array<{
    id: number;
    name: string;
    rate_currency: string | null;
  }>;
  const byId = new Map<number, { id: number; rate_currency: string | null }>();
  const byName = new Map<string, { id: number; rate_currency: string | null }>();
  for (const p of projects) {
    byId.set(Number(p.id), { id: Number(p.id), rate_currency: p.rate_currency });
    // On duplicate names the first wins; ambiguity is reported per-row below.
    const key = p.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, { id: Number(p.id), rate_currency: p.rate_currency });
  }

  const user = (await db('users').where('id', userId).first('base_currency')) as {
    base_currency: string;
  };
  const baseCurrency = user.base_currency;

  // Existing (project, date, amount, note) keys so a re-import skips duplicates. Note null is
  // normalized to '' for matching so an imported empty note equals a stored NULL note.
  const existing = (await db('income_entries as e')
    .join('projects as p', 'p.id', 'e.project_id')
    .where('p.user_id', userId)
    .select(
      'e.project_id',
      db.raw("DATE_FORMAT(e.date, '%Y-%m-%d') as date"),
      'e.amount',
      'e.note',
    )) as Array<{ project_id: number; date: string; amount: string; note: string | null }>;
  const seenKeys = new Set(
    existing.map((e) => entryKey(Number(e.project_id), e.date, e.amount, e.note)),
  );

  for (let i = 1; i < records.length; i++) {
    const record = records[i];
    if (record === undefined || isBlankRecord(record)) continue;
    const display = i + 1;
    const rowErrors: ImportError[] = [];

    // Resolve the project. Untargeted: by project_id if present & owned, else by exact
    // (case-insensitive) name. Targeted: default to the target when no project is named; if a
    // project IS named it must resolve to the target, otherwise the row is rejected (never rerouted).
    const idRaw = cell(record, idx, 'project_id');
    const nameRaw = cell(record, idx, 'project_name');
    let project: { id: number; rate_currency: string | null } | undefined;

    if (targetProjectId !== undefined) {
      const target = byId.get(targetProjectId);
      if (idRaw === '' && nameRaw === '') {
        project = target;
      } else {
        // The row names a project; find which, then require it to be the target.
        let named: { id: number; rate_currency: string | null } | undefined;
        if (idRaw !== '') {
          const pid = Number(idRaw);
          if (Number.isInteger(pid)) named = byId.get(pid);
        }
        if (!named && nameRaw !== '') named = byName.get(nameRaw.toLowerCase());

        if (named && named.id === targetProjectId) {
          project = target;
        } else {
          rowErrors.push({
            row: display,
            field: 'project',
            message: 'row belongs to a different project',
          });
        }
      }
    } else {
      if (idRaw !== '') {
        const pid = Number(idRaw);
        if (Number.isInteger(pid)) project = byId.get(pid);
      }
      if (!project && nameRaw !== '') {
        project = byName.get(nameRaw.toLowerCase());
      }
      if (!project) {
        const ref = idRaw !== '' ? `id ${idRaw}` : nameRaw !== '' ? `"${nameRaw}"` : '(none given)';
        rowErrors.push({ row: display, field: 'project', message: `unknown project ${ref}` });
      }
    }

    const date = cell(record, idx, 'date');
    if (!isValidDate(date)) {
      rowErrors.push({
        row: display,
        field: 'date',
        message: `invalid date "${date}" (expected YYYY-MM-DD)`,
      });
    }

    const amountRaw = cell(record, idx, 'amount');
    let amount = 0;
    if (amountRaw === '' || !Number.isFinite(Number(amountRaw))) {
      rowErrors.push({ row: display, field: 'amount', message: `invalid amount "${amountRaw}"` });
    } else {
      amount = Number(amountRaw);
    }

    const curRaw = cell(record, idx, 'currency');
    let currency: string | null = null;
    if (curRaw !== '') {
      if (!CURRENCY_RE.test(curRaw)) {
        rowErrors.push({
          row: display,
          field: 'currency',
          message: `invalid currency "${curRaw}" (expected 3-letter code)`,
        });
      } else {
        currency = curRaw;
      }
    }

    const noteRaw = cell(record, idx, 'note');
    const note = noteRaw === '' ? null : noteRaw;
    if (note !== null && note.length > 500) {
      rowErrors.push({ row: display, field: 'note', message: 'note is too long (max 500)' });
    }

    if (rowErrors.length > 0 || !project) {
      errors.push(...rowErrors);
      continue;
    }

    // Currency default mirrors the POST route: explicit → project rate currency → user base.
    const resolvedCurrency = currency ?? project.rate_currency ?? baseCurrency;

    const dedupKey = entryKey(project.id, date, amount, note);
    const duplicate = seenKeys.has(dedupKey);
    if (!duplicate) seenKeys.add(dedupKey);

    prepared.push({
      display,
      dedupKey,
      duplicate,
      values: {
        project_id: project.id,
        date,
        amount,
        currency: resolvedCurrency,
        note,
      },
    });
  }

  return { prepared, errors };
}

// Build the (project, date, amount, note) dedup key. Amount is normalized to 2dp (the decimal(14,2)
// column's precision) so "240" and "240.00" collide; note null/'' collapse to the same key.
function entryKey(
  projectId: number,
  date: string,
  amount: string | number,
  note: string | null,
): string {
  const amt = Number(amount).toFixed(2);
  return `${projectId}|${date}|${amt}|${note ?? ''}`;
}

// ---------------------------------------------------------------------------
// Import — route
// ---------------------------------------------------------------------------

// Which tables accept an import, and the prepare + insert pair for each. `insert` runs inside the
// commit transaction and receives only the rows that are NOT duplicates.
const IMPORT_TABLES: Record<
  string,
  {
    prepare: (
      userId: number,
      records: string[][],
      targetProjectId?: number,
    ) => Promise<{ prepared: PreparedRow<unknown>[]; errors: ImportError[] }>;
    insert: (trx: Knex.Transaction, userId: number, rows: unknown[]) => Promise<void>;
  }
> = {
  projects: {
    prepare: prepareProjectImport,
    insert: async (trx, userId, rows) => {
      const values = rows as ProjectImportValues[];
      for (const v of values) {
        await trx('projects').insert({ user_id: userId, ...v });
      }
    },
  },
  'income-entries': {
    prepare: prepareEntryImport,
    insert: async (trx, _userId, rows) => {
      const values = rows as EntryImportValues[];
      for (const v of values) {
        await trx('income_entries').insert(v);
      }
    },
  },
};

// POST /api/import/:table?dry_run=true — validate (always) and, when dry_run=false and there are
// zero errors, insert non-duplicate rows in one all-or-nothing transaction. The body is EITHER raw
// CSV text OR an .xlsx upload; two body parsers pick the shape by Content-Type (the XLSX MIME → a
// Buffer via express.raw; anything else → a string via express.text). The first parser to match
// consumes the body, so the second is a no-op. Both cap at 10 MB, whose overflow throws
// entity.too.large → the app-level 413. Whichever wire format arrives, it is reduced to the SAME
// string[][] and handed to the SAME spec.prepare — no format-specific validation exists.
importRouter.post(
  '/:table',
  rawBody({ type: XLSX_MIME, limit: '10mb' }),
  textBody({ type: () => true, limit: '10mb' }),
  async (req, res) => {
    const userId = req.userId as number;
    const table = req.params.table;
    const spec = IMPORT_TABLES[table];
    if (!spec) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    // dry_run defaults to true; only an explicit ?dry_run=false performs the real import.
    const dryRun = req.query.dry_run !== 'false';

    // Optional ?project=<id> pins every row to one project (income-entries only). The target must be
    // owned and NOT soft-deleted (you cannot import into a deleted project).
    let targetProjectId: number | undefined;
    const targetRaw = typeof req.query.project === 'string' ? req.query.project : undefined;
    if (targetRaw !== undefined && targetRaw !== '') {
      if (table !== 'income-entries') {
        res.status(400).json({
          error: 'project_target_unsupported',
          message: `?project is not valid for the "${table}" import`,
        });
        return;
      }
      const pid = Number(targetRaw);
      if (!Number.isInteger(pid) || pid <= 0) {
        res
          .status(400)
          .json({ error: 'invalid_project', message: 'project must be a positive integer id' });
        return;
      }
      if (!(await ownsProject(userId, pid, false))) {
        res.status(404).json({ error: 'not_found', message: 'project not found' });
        return;
      }
      targetProjectId = pid;
    }

    // A Buffer body means the XLSX parser ran (Content-Type was the spreadsheet MIME); a string body
    // means the text parser ran (CSV). Reduce whichever to the common string[][] records shape.
    let records: string[][];
    try {
      if (Buffer.isBuffer(req.body)) {
        if (req.body.length === 0) {
          res.status(422).json({ error: 'invalid_xlsx', message: 'empty request body' });
          return;
        }
        records = await parseXlsxSheet(req.body);
      } else {
        const raw = typeof req.body === 'string' ? req.body : '';
        if (raw.trim() === '') {
          res.status(422).json({ error: 'invalid_csv', message: 'empty request body' });
          return;
        }
        records = parseCsv(raw);
      }
    } catch (err) {
      const isCsv = !Buffer.isBuffer(req.body);
      const message =
        err instanceof CsvParseError
          ? err.message
          : isCsv
            ? 'could not parse CSV'
            : 'could not parse XLSX';
      res.status(422).json({ error: isCsv ? 'invalid_csv' : 'invalid_xlsx', message });
      return;
    }

    if (records.length === 0) {
      res.status(422).json({ error: 'invalid_import', message: 'no rows found' });
      return;
    }

    const { prepared, errors } = await spec.prepare(userId, records, targetProjectId);

    // Duplicates (existing DB rows or earlier in-file rows) were flagged during prepare; they are
    // reported as skips and never inserted. The rest are the inserts.
    const insertRows = prepared.filter((r) => !r.duplicate);
    const skip = prepared.length - insertRows.length;

    const report: ImportReport = {
      dry_run: dryRun,
      valid_rows: prepared.length,
      insert_rows: insertRows.length,
      skip_rows: skip,
      errors,
    };

    if (dryRun) {
      res.json(report);
      return;
    }

    // Real import requires a clean validation pass — no partial imports.
    if (errors.length > 0) {
      res.status(422).json({ error: 'validation', ...report });
      return;
    }

    await db.transaction(async (trx) => {
      await spec.insert(
        trx,
        userId,
        insertRows.map((r) => r.values),
      );
    });

    res.json({ ...report, dry_run: false });
  },
);
