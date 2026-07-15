import { Router } from 'express';
import { db } from '../db/index.js';
import { assertProjectOwned } from '../domain/ownership.js';
import { computeMetricsForUser } from '../domain/metrics.js';
import { LINK_TYPES, type LinkType } from '../domain/constants.js';

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

// One connection between two cards, directed from_project_id ▸ to_project_id. `type` is one of
// LINK_TYPES (app-validated). The client decides whether/how to draw it; ids come back as numbers.
interface ProjectLink {
  id: number;
  from_project_id: number;
  to_project_id: number;
  type: string;
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

// Parse a link endpoint id off the request body (may arrive as a number or a numeric string), or
// null when it is not an integer (→ 422). Mirrors parseId but tolerant of the body value type.
function parseBodyId(raw: unknown): number | null {
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

// Would adding a `parent` link fromId ▸ toId (fromId becomes the parent of toId) close a cycle?
// A `parent` link means the `from` project is the parent of the `to` project, so a child's parent
// is the `from` of the link whose `to` is that child. Adding fromId as parent of toId creates a
// cycle iff fromId is already a descendant of toId — i.e. walking UP the ancestor chain from
// fromId (child → parent) we can reach toId. We load all live parent links into a child→parents
// adjacency and do a bounded walk guarded by a visited-set (and an iteration cap) so any
// pre-existing inconsistent data cannot spin forever.
async function wouldCreateParentCycle(
  userId: number,
  fromId: number,
  toId: number,
): Promise<boolean> {
  const links = (await db('project_links')
    .where({ user_id: userId, type: 'parent' })
    .whereNull('deleted_at')
    .select('from_project_id', 'to_project_id')) as Array<{
    from_project_id: number;
    to_project_id: number;
  }>;

  // childId → parentIds (a child may have more than one parent across ordered pairs).
  const parents = new Map<number, number[]>();
  for (const link of links) {
    const child = Number(link.to_project_id);
    const parent = Number(link.from_project_id);
    const list = parents.get(child) ?? [];
    list.push(parent);
    parents.set(child, list);
  }

  const maxIterations = links.length + 1;
  const visited = new Set<number>();
  const stack: number[] = [fromId];
  let iterations = 0;
  while (stack.length > 0) {
    if (iterations++ > maxIterations) break; // guard against inconsistent pre-existing data
    const node = stack.pop() as number;
    if (node === toId) return true;
    if (visited.has(node)) continue;
    visited.add(node);
    for (const parent of parents.get(node) ?? []) {
      stack.push(parent);
    }
  }
  return false;
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

  // Live links whose BOTH endpoints are owned, non-deleted projects. link.user_id already scopes
  // to this user; joining through projects twice additionally hides links to soft-deleted (or
  // otherwise not-owned) projects. Returned regardless of placement — the client decides
  // drawability against the placed set.
  const linkRows = (await db('project_links as pl')
    .join('projects as p_from', 'p_from.id', 'pl.from_project_id')
    .join('projects as p_to', 'p_to.id', 'pl.to_project_id')
    .where('pl.user_id', userId)
    .whereNull('pl.deleted_at')
    .andWhere('p_from.user_id', userId)
    .whereNull('p_from.deleted_at')
    .andWhere('p_to.user_id', userId)
    .whereNull('p_to.deleted_at')
    .select<ProjectLink[]>(
      'pl.id',
      'pl.from_project_id',
      'pl.to_project_id',
      'pl.type',
    )) as ProjectLink[];

  res.json({
    placed: placedRows.map((row) => toItem(row, true)),
    tray: trayRows.map((row) => toItem(row, false)),
    links: linkRows.map((row) => ({
      id: Number(row.id),
      from_project_id: Number(row.from_project_id),
      to_project_id: Number(row.to_project_id),
      type: row.type,
    })),
  });
});

// ---------------------------------------------------------------------------
// Links — defined BEFORE the single-segment /:projectId routes so the two-segment /links paths
// are matched first and never swallowed by /:projectId.
// ---------------------------------------------------------------------------

// POST /api/canvas/links — connect two owned projects with a typed relationship. Upserts on the
// unique (user, from, to) so re-linking a previously removed pair revives that soft-deleted row.
canvasRouter.post('/links', async (req, res) => {
  const userId = req.userId as number;
  const body = (req.body ?? {}) as Record<string, unknown>;

  const fromProjectId = parseBodyId(body.from_project_id);
  const toProjectId = parseBodyId(body.to_project_id);
  const rawType = body.type;

  const fields: Record<string, string> = {};
  if (fromProjectId === null) fields.from_project_id = 'invalid';
  if (toProjectId === null) fields.to_project_id = 'invalid';
  if (typeof rawType !== 'string' || !LINK_TYPES.includes(rawType as LinkType)) {
    fields.type = 'invalid';
  }
  if (Object.keys(fields).length > 0) {
    res.status(422).json({ error: 'validation', fields });
    return;
  }
  // Narrowed by the checks above.
  const type = rawType as LinkType;

  // A project cannot link to itself.
  if (fromProjectId === toProjectId) {
    res.status(422).json({ error: 'validation', fields: { to_project_id: 'invalid' } });
    return;
  }

  // Both endpoints must be owned + non-deleted.
  const ownership: Record<string, string> = {};
  const fromOwned = await assertProjectOwned(userId, fromProjectId as number);
  if (!fromOwned) ownership.from_project_id = 'invalid';
  const toOwned = await assertProjectOwned(userId, toProjectId as number);
  if (!toOwned) ownership.to_project_id = 'invalid';
  if (Object.keys(ownership).length > 0) {
    res.status(422).json({ error: 'validation', fields: ownership });
    return;
  }

  // Reject a duplicate LIVE link between this pair in EITHER direction.
  const liveExisting = await db('project_links')
    .where('user_id', userId)
    .whereNull('deleted_at')
    .andWhere(function () {
      this.where({ from_project_id: fromProjectId, to_project_id: toProjectId }).orWhere({
        from_project_id: toProjectId,
        to_project_id: fromProjectId,
      });
    })
    .first('id');
  if (liveExisting) {
    res.status(409).json({ error: 'link_exists' });
    return;
  }

  // A parent link must not close a cycle in the parent hierarchy.
  if (type === 'parent') {
    const cycle = await wouldCreateParentCycle(
      userId,
      fromProjectId as number,
      toProjectId as number,
    );
    if (cycle) {
      res.status(422).json({ error: 'validation', fields: { to_project_id: 'cycle' } });
      return;
    }
  }

  // Upsert on the unique (user_id, from_project_id, to_project_id). Look up any existing row
  // (including soft-deleted) for this ordered pair so re-linking a removed pair revives that row
  // instead of colliding on the unique key. Because the 409 check already covered live links in
  // either direction, an existing row found here is a soft-deleted same-ordered-pair row.
  const existing = await db('project_links')
    .where({ user_id: userId, from_project_id: fromProjectId, to_project_id: toProjectId })
    .first('id');

  let linkId: number;
  if (existing) {
    linkId = (existing as { id: number }).id;
    await db('project_links')
      .where('id', linkId)
      .update({ type, deleted_at: null, updated_at: db.fn.now() });
  } else {
    const [inserted] = await db('project_links').insert({
      user_id: userId,
      from_project_id: fromProjectId,
      to_project_id: toProjectId,
      type,
    });
    linkId = inserted as number;
  }

  res.status(201).json({
    id: Number(linkId),
    from_project_id: fromProjectId as number,
    to_project_id: toProjectId as number,
    type,
  });
});

// PATCH /api/canvas/links/:id — change a live link's type. Direction is fixed here (re-drawing the
// other way is delete + create); a change to `parent` re-runs the cycle check on this row's pair.
canvasRouter.patch('/links/:id', async (req, res) => {
  const userId = req.userId as number;
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const rawType = body.type;
  if (typeof rawType !== 'string' || !LINK_TYPES.includes(rawType as LinkType)) {
    res.status(422).json({ error: 'validation', fields: { type: 'invalid' } });
    return;
  }
  const type = rawType as LinkType;

  const link = (await db('project_links')
    .where({ id, user_id: userId })
    .whereNull('deleted_at')
    .first('id', 'from_project_id', 'to_project_id')) as
    { id: number; from_project_id: number; to_project_id: number } | undefined;
  if (!link) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  if (type === 'parent') {
    const cycle = await wouldCreateParentCycle(
      userId,
      Number(link.from_project_id),
      Number(link.to_project_id),
    );
    if (cycle) {
      res.status(422).json({ error: 'validation', fields: { to_project_id: 'cycle' } });
      return;
    }
  }

  await db('project_links').where('id', id).update({ type, updated_at: db.fn.now() });

  res.status(200).json({
    id: Number(link.id),
    from_project_id: Number(link.from_project_id),
    to_project_id: Number(link.to_project_id),
    type,
  });
});

// DELETE /api/canvas/links/:id — remove a connection by soft-deleting its live link row. Never a
// hard delete. 404 when there is no live row to remove.
canvasRouter.delete('/links/:id', async (req, res) => {
  const userId = req.userId as number;
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const affected = await db('project_links')
    .where({ id, user_id: userId })
    .whereNull('deleted_at')
    .update({ deleted_at: db.fn.now() });

  if (affected === 0) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.status(204).end();
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
