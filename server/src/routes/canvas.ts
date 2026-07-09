import { Router } from 'express';
import { db } from '../db/index.js';
import { assertProjectOwned } from '../domain/ownership.js';
import { computeMetricsForUser } from '../domain/metrics.js';

// Canvas board (§ canvas). One router mounted at /api/canvas, behind requireAuth in app.ts, every
// query scoped to req.userId. A project is "on the board" when it has a live (deleted_at IS NULL)
// canvas_positions row; removing a card soft-deletes that row, re-placing revives it.
export const canvasRouter = Router();

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

// One card as returned to the client. `x`/`y` are present only for placed cards; tray cards omit
// them. feeling/trend are the self-reported project annotations. Money figures are the same
// normalized, base-currency, 2dp-rounded values the dashboard uses (via computeMetricsForUser).
interface CanvasItem {
  project_id: number;
  name: string;
  type: string;
  type_label: string;
  status: string;
  feeling: string | null;
  trend: string | null;
  x?: number;
  y?: number;
  note_count: number;
  monthly_revenue: number | null;
  effective_hourly_rate: number | null;
  base_currency: string;
}

// Row shape shared by the placed/tray project selects (x/y only present on the placed query).
interface CardRow {
  id: number;
  name: string;
  type: string;
  type_label: string;
  status: string;
  feeling: string | null;
  trend: string | null;
  x?: number;
  y?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Parse a :projectId route param to a positive integer, or null when it is not one (→ 404).
function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

// Round a display money figure to 2dp; null (no data) passes through untouched. Mirrors the
// projects route — normalization keeps full precision, the API rounds.
function roundMoney(value: number | null): number | null {
  if (value === null) return null;
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /api/canvas — the whole board: cards placed on the canvas plus the tray of owned,
// non-deleted projects not yet placed. Both card sets carry the same normalized figures and note
// counts so the client renders them identically.
canvasRouter.get('/', async (req, res) => {
  const userId = req.userId as number;

  // Base currency (defaults to EUR if the user row is somehow missing), like the metrics route.
  const user = await db('users').where('id', userId).first('base_currency');
  const baseCurrency = (user as { base_currency: string } | undefined)?.base_currency ?? 'EUR';

  // The one normalization entry point — never recompute by hand.
  const metrics = await computeMetricsForUser(userId);

  // Note counts per project in a single grouped query, scoped through the owning project.
  const noteRows = (await db('notes as n')
    .join('projects as p', 'p.id', 'n.project_id')
    .where('p.user_id', userId)
    .whereNull('p.deleted_at')
    .groupBy('n.project_id')
    .select('n.project_id')
    .count({ count: 'n.id' })) as Array<{ project_id: number; count: number | string }>;
  const noteCounts = new Map<number, number>();
  for (const row of noteRows) {
    noteCounts.set(Number(row.project_id), Number(row.count));
  }

  const toItem = (row: CardRow, placed: boolean): CanvasItem => {
    const m = metrics.get(row.id);
    const item: CanvasItem = {
      project_id: row.id,
      name: row.name,
      type: row.type,
      type_label: row.type_label,
      status: row.status,
      feeling: row.feeling,
      trend: row.trend,
      note_count: noteCounts.get(row.id) ?? 0,
      monthly_revenue: roundMoney(m?.monthlyRevenue ?? null),
      effective_hourly_rate: roundMoney(m?.effectiveHourlyRate ?? null),
      base_currency: baseCurrency,
    };
    if (placed) {
      item.x = Number(row.x);
      item.y = Number(row.y);
    }
    return item;
  };

  // Placed cards: live canvas_positions joined to their (owned, non-deleted) project and type.
  const placedRows = (await db('canvas_positions as cp')
    .join('projects as p', 'cp.project_id', 'p.id')
    .join('project_types as pt', 'pt.id', 'p.type')
    .where('cp.user_id', userId)
    .whereNull('cp.deleted_at')
    .andWhere('p.user_id', userId)
    .whereNull('p.deleted_at')
    .select<CardRow[]>(
      'p.id',
      'p.name',
      'p.type',
      'pt.label as type_label',
      'p.status',
      'p.feeling',
      'p.trend',
      'cp.x',
      'cp.y',
    )) as CardRow[];

  // Tray: owned, non-deleted projects with NO live canvas_positions row.
  const trayRows = (await db('projects as p')
    .join('project_types as pt', 'pt.id', 'p.type')
    .where('p.user_id', userId)
    .whereNull('p.deleted_at')
    .whereNotExists(function () {
      this.select(db.raw('1'))
        .from('canvas_positions as cp')
        .whereRaw('cp.project_id = p.id')
        .andWhere('cp.user_id', userId)
        .whereNull('cp.deleted_at');
    })
    .select<CardRow[]>(
      'p.id',
      'p.name',
      'p.type',
      'pt.label as type_label',
      'p.status',
      'p.feeling',
      'p.trend',
    )) as CardRow[];

  res.json({
    placed: placedRows.map((row) => toItem(row, true)),
    tray: trayRows.map((row) => toItem(row, false)),
  });
});

// PUT /api/canvas/:projectId — place (or move) a project on the board at (x, y). Upserts the
// per-(user, project) position row: an existing row (even a soft-deleted one) is updated and
// revived (deleted_at cleared); otherwise a new row is inserted. Returns the resulting position.
canvasRouter.put('/:projectId', async (req, res) => {
  const userId = req.userId as number;
  const projectId = parseId(req.params.projectId);
  if (projectId === null) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const fields: Record<string, string> = {};
  const { x, y } = body;
  if (typeof x !== 'number' || !Number.isInteger(x) || x < 0) {
    fields.x = 'invalid';
  }
  if (typeof y !== 'number' || !Number.isInteger(y) || y < 0) {
    fields.y = 'invalid';
  }
  if (Object.keys(fields).length > 0) {
    res.status(422).json({ error: 'validation', fields });
    return;
  }

  const project = await assertProjectOwned(userId, projectId);
  if (!project) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  // Upsert on the unique (user_id, project_id). Look up any existing row (including soft-deleted)
  // so re-placing a removed card revives the same row instead of colliding on the unique key.
  const existing = await db('canvas_positions')
    .where({ user_id: userId, project_id: projectId })
    .first('id');

  if (existing) {
    await db('canvas_positions')
      .where('id', (existing as { id: number }).id)
      .update({ x, y, deleted_at: null, updated_at: db.fn.now() });
  } else {
    await db('canvas_positions').insert({
      user_id: userId,
      project_id: projectId,
      x,
      y,
    });
  }

  res.status(200).json({ project_id: projectId, x, y });
});

// DELETE /api/canvas/:projectId — remove a card from the board by soft-deleting its live position
// row. The project itself is untouched. 404 when there is no live row to remove.
canvasRouter.delete('/:projectId', async (req, res) => {
  const userId = req.userId as number;
  const projectId = parseId(req.params.projectId);
  if (projectId === null) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const affected = await db('canvas_positions')
    .where({ user_id: userId, project_id: projectId })
    .whereNull('deleted_at')
    .update({ deleted_at: db.fn.now() });

  if (affected === 0) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.status(204).end();
});
