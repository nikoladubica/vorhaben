import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { Project, ProjectType } from '../types';
import { listProjectTypes, listProjects, restoreProject } from '../api/projects';
import { ProjectFilters } from '../components/projects/ProjectFilters';
import { StatusBadge } from '../components/projects/StatusBadge';

// A soft-deleted project handed over from the form via navigation state, so the list can
// offer an undo without a "deleted projects" view (the list API hides deleted rows).
interface Trashed {
  id: number;
  name: string;
}

// "2023-02-01" → "Feb 2023". Parse as UTC midnight to avoid a timezone off-by-one.
function formatMonthYear(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatRan(project: Project): string {
  const start = formatMonthYear(project.start_date);
  const end = project.end_date ? formatMonthYear(project.end_date) : 'ongoing';
  return `${start} — ${end}`;
}

export function ProjectsPage() {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();

  const [projects, setProjects] = useState<Project[]>([]);
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

      <div className="panel" style={{ marginTop: 20 }}>
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
                  <th>Tags</th>
                  <th>Status</th>
                  <th className="r">Edit</th>
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
                    <td>
                      <span className="tag-cell">
                        {p.tags.map((t) => (
                          <span className="tag" key={t}>
                            {t}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td>
                      <StatusBadge status={p.status} />
                    </td>
                    <td className="r">
                      <Link className="edit-link" to={`/projects/${p.id}/edit`}>
                        Edit
                      </Link>
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
