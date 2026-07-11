import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { ProjectType, ProjectWithMetrics } from '../types';
import type { TimelineProject } from '../api/dashboard';
import { listProjectTypes, listProjects, restoreProject } from '../api/projects';
import { ProjectFilters } from '../components/projects/ProjectFilters';
import { StatusBadge } from '../components/projects/StatusBadge';
import { Timeline } from '../components/dashboard/Timeline';
import { WeeklyRitual } from '../components/close/WeeklyRitual';
import { formatMoney } from '../domain/format';
import { useAuth } from '../auth/useAuth';

// A soft-deleted project handed over from the form via navigation state, so the list can
// offer an undo without a "deleted projects" view (the list API hides deleted rows).
interface Trashed {
  id: number;
  name: string;
}

// "2023-02-01" → "Feb 2023". Parse as UTC midnight to avoid a timezone off-by-one.
function formatMonthYear(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// "2025-04-01" → "Apr" (month only, for collapsing a same-year span like "Apr — Jul 2025").
function formatMonthOnly(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
}

// The "Ran" cell, mirroring the design: ongoing → "Feb 2023 —"; a span within one year collapses
// the start year ("Apr — Jul 2025"); a cross-year span keeps both ("Sep 2024 — Mar 2025").
function formatRan(project: ProjectWithMetrics): string {
  if (!project.end_date) return `${formatMonthYear(project.start_date)} —`;
  const sameYear = project.start_date.slice(0, 4) === project.end_date.slice(0, 4);
  const startLabel = sameYear
    ? formatMonthOnly(project.start_date)
    : formatMonthYear(project.start_date);
  return `${startLabel} — ${formatMonthYear(project.end_date)}`;
}

// Absolute month index of a 'YYYY-MM' (or longer) date key, and its inverse — for enumerating the
// timeline's month window without Date-arithmetic drift.
const monthAbs = (key: string) => Number(key.slice(0, 4)) * 12 + (Number(key.slice(5, 7)) - 1);
const monthKeyFromAbs = (n: number) =>
  `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`;

// The oldest-first 'YYYY-MM' window spanning every project: from the earliest start to the latest
// end (open-ended projects run to the current month).
function buildMonths(projects: ProjectWithMetrics[]): string[] {
  if (projects.length === 0) return [];
  const now = new Date();
  const todayKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  let min = projects[0].start_date.slice(0, 7);
  let max = todayKey;
  for (const p of projects) {
    const start = p.start_date.slice(0, 7);
    if (start < min) min = start;
    const end = p.end_date ? p.end_date.slice(0, 7) : todayKey;
    if (end > max) max = end;
  }
  const months: string[] = [];
  for (let i = monthAbs(min); i <= monthAbs(max); i++) months.push(monthKeyFromAbs(i));
  return months;
}

export function ProjectsPage() {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const auth = useAuth();
  const baseCurrency = auth.status === 'user' ? auth.user.base_currency : '';

  const [projects, setProjects] = useState<ProjectWithMetrics[]>([]);
  const [types, setTypes] = useState<ProjectType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Take the trashed hand-off once, then strip it from history so a reload won't re-show it.
  const [trashed, setTrashed] = useState<Trashed | null>(() => {
    const state = location.state as { trashed?: Trashed } | null;
    return state?.trashed ?? null;
  });
  useEffect(() => {
    if ((location.state as { trashed?: Trashed } | null)?.trashed) {
      navigate(location.pathname + location.search, { replace: true, state: null });
    }
    // Only on mount — the hand-off is consumed into local state above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filters = useMemo(
    () => ({
      status: searchParams.get('status') ?? undefined,
      type: searchParams.get('type') ?? undefined,
      tag: searchParams.get('tag') ?? undefined,
    }),
    [searchParams],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listProjects(filters);
      setProjects(rows);
    } catch {
      setError('Could not load projects. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    listProjectTypes()
      .then(setTypes)
      .catch(() => setTypes([]));
  }, []);

  const typeLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of types) map.set(t.id, t.label);
    return map;
  }, [types]);

  // Timeline inputs, derived from the loaded list. The Timeline component (shared with the
  // dashboard) takes the lighter TimelineProject shape, the month window, and the id of the
  // best-effective-rate project — which we paint red, per the design's "red = best effective rate".
  const months = useMemo(() => buildMonths(projects), [projects]);
  const timelineProjects = useMemo<TimelineProject[]>(
    () =>
      projects.map((p) => ({
        project_id: p.id,
        name: p.name,
        status: p.status,
        start_date: p.start_date,
        end_date: p.end_date,
      })),
    [projects],
  );
  const bestRateProjectId = useMemo(() => {
    let bestId: number | null = null;
    let bestRate = -Infinity;
    for (const p of projects) {
      if (p.effective_hourly_rate !== null && p.effective_hourly_rate > bestRate) {
        bestRate = p.effective_hourly_rate;
        bestId = p.id;
      }
    }
    return bestId;
  }, [projects]);
  const activeCount = useMemo(
    () => projects.filter((p) => p.status === 'active').length,
    [projects],
  );
  const timelineRange =
    months.length > 0
      ? `${formatMonthYear(`${months[0]}-01`)} — ${formatMonthYear(`${months[months.length - 1]}-01`)}`
      : '';

  async function onUndo() {
    if (!trashed) return;
    try {
      await restoreProject(trashed.id);
      setTrashed(null);
      await load();
    } catch {
      setError('Could not restore the project. Please try again.');
    }
  }

  const hasFilters = Boolean(filters.status || filters.type || filters.tag);

  return (
    <div>
      <div className="dash-head">
        <h3>Projects</h3>
        <div className="pd-actions">
          <Link className="btn primary sm" to="/projects/new">
            New project
          </Link>
        </div>
      </div>

      <WeeklyRitual />

      {trashed && (
        <div className="undo-banner" role="status">
          <span>
            Moved <strong>{trashed.name}</strong> to trash.
          </span>
          <div className="undo-actions">
            <button type="button" className="btn ghost sm" onClick={onUndo}>
              Undo
            </button>
            <button
              type="button"
              className="undo-dismiss"
              aria-label="Dismiss"
              onClick={() => setTrashed(null)}
            >
              ×
            </button>
          </div>
        </div>
      )}

      <ProjectFilters types={types} />

      {/* Timeline (design screen 05): a Gantt strip over the full span of every project, with the
          best-effective-rate project painted red. Only shown once there are projects to place. */}
      {!loading && !error && projects.length > 0 && (
        <div className="panel" style={{ marginTop: 20 }}>
          <div className="panel-h">
            <span className="t">Timeline</span>
            <span className="s num">{timelineRange} · red = best effective rate</span>
          </div>
          <div className="panel-b tl-panel">
            <Timeline
              timeline={timelineProjects}
              months={months}
              bestRateProjectId={bestRateProjectId}
            />
          </div>
        </div>
      )}

      <div className="panel" style={{ marginTop: 20 }}>
        <div className="panel-h">
          <span className="t">All projects</span>
          {!loading && !error && projects.length > 0 && (
            <span className="s num">
              {projects.length} total · {activeCount} active
            </span>
          )}
        </div>
        <div className="panel-b table-scroll" style={{ paddingTop: 4 }}>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : loading ? (
            <p className="table-empty">Loading…</p>
          ) : projects.length === 0 ? (
            <div className="table-empty">
              {hasFilters ? (
                <p>No projects match these filters.</p>
              ) : (
                <>
                  <p>No projects yet. Track your first job, gig, or product.</p>
                  <Link className="btn primary sm" to="/projects/new">
                    Create your first project
                  </Link>
                </>
              )}
            </div>
          ) : (
            <table className="projects">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Type</th>
                  <th>Ran</th>
                  <th className="r">Monthly-equiv.</th>
                  <th className="r">Rate</th>
                  <th className="r">Total earned</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link className="project-link" to={`/projects/${p.id}`}>
                        {p.name}
                      </Link>
                    </td>
                    <td>{typeLabels.get(p.type) ?? p.type}</td>
                    <td className="num">{formatRan(p)}</td>
                    <td className="r num">
                      {p.monthly_revenue === null
                        ? '—'
                        : formatMoney(String(p.monthly_revenue), baseCurrency)}
                    </td>
                    <td className="r num">
                      {p.effective_hourly_rate === null
                        ? '—'
                        : `${formatMoney(String(p.effective_hourly_rate), '')}/h`}
                    </td>
                    <td className="r num">
                      {p.total_revenue === null
                        ? '—'
                        : formatMoney(String(p.total_revenue), baseCurrency)}
                    </td>
                    <td>
                      <StatusBadge status={p.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
