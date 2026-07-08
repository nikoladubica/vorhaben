// Project detail — the data-entry heart of the app. Loads a project, exposes lifecycle actions
// (Pause / Resume / End project) with optimistic status, and hosts the income-entry and
// time-log quick-add sections under a shared, URL-bound date-range filter (default: last 3
// months, the normalization window). Per-project metrics/notes are later tickets (mount points
// below). Status is derived, never free-set — the local deriveStatus mirrors the server (§1.3).

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type {
  Project,
  ProjectPayload,
  ProjectStatus,
  ProjectType,
} from '../types';
import { getProject, listProjectTypes, updateProject } from '../api/projects';
import {
  COMPENSATION_CONFIG,
  modelHasAmount,
} from '../domain/compensation';
import {
  formatFullDate,
  formatMoney,
  formatMonthYear,
  todayString,
} from '../domain/format';
import { StatusBadge } from '../components/projects/StatusBadge';
import { EntriesSection } from '../components/entries/EntriesSection';
import { TimeLogsSection } from '../components/entries/TimeLogsSection';

// today minus 3 months, YYYY-MM-DD — the default range lower bound (normalization window §2.2).
function threeMonthsAgo(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 3);
  return d.toISOString().slice(0, 10);
}

// Mirror of server deriveStatus (server/src/domain/projectStatus.ts) for optimistic UI only.
// The server's response is always taken as the source of truth once the PATCH resolves.
function deriveStatus(
  flag: 'paused' | 'idea' | null,
  start: string,
  end: string | null,
  today: string,
): ProjectStatus {
  if (flag === 'idea' || start > today) return 'idea';
  if (end !== null && end < today) return 'ended';
  if (flag === 'paused') return 'paused';
  return 'active';
}

type StatusOverride = { status?: ProjectStatus; end_date?: string | null };

// Build a full PATCH payload from the current project plus an override. `ended` is derived, not
// stored intent, so it maps back to `active` (the server rejects an explicit `ended`).
function toPayload(project: Project, override: StatusOverride): ProjectPayload {
  const status =
    override.status ?? (project.status === 'ended' ? 'active' : project.status);
  return {
    name: project.name,
    type: project.type,
    description: project.description,
    status,
    start_date: project.start_date,
    end_date:
      override.end_date !== undefined ? override.end_date : project.end_date,
    compensation_model: project.compensation_model,
    rate_amount: project.rate_amount === null ? null : Number(project.rate_amount),
    rate_currency: project.rate_currency,
    tags: project.tags,
  };
}

// Optimistic status for an override, computed exactly as the server would.
function optimisticStatus(project: Project, override: StatusOverride): ProjectStatus {
  const choice =
    override.status ?? (project.status === 'ended' ? 'active' : project.status);
  const flag = choice === 'paused' ? 'paused' : choice === 'idea' ? 'idea' : null;
  const end = override.end_date !== undefined ? override.end_date : project.end_date;
  return deriveStatus(flag, project.start_date, end, todayString());
}

// e.g. "Hourly, CHF 62/h", "Monthly salary, CHF 4'000". Derived only from COMPENSATION_CONFIG.
function compensationSummary(project: Project): string {
  const cfg = COMPENSATION_CONFIG[project.compensation_model];
  if (!modelHasAmount(project.compensation_model) || project.rate_amount === null) {
    return cfg.label;
  }
  const money = formatMoney(project.rate_amount, project.rate_currency ?? '');
  return project.compensation_model === 'hourly'
    ? `${cfg.label}, ${money}/h`
    : `${cfg.label}, ${money}`;
}

export function ProjectDetailPage() {
  const { id } = useParams();
  const projectId = id ? Number(id) : null;
  const [searchParams, setSearchParams] = useSearchParams();

  const [project, setProject] = useState<Project | null>(null);
  const [types, setTypes] = useState<ProjectType[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);

  // Default range: last 3 months. Read from the URL so the view is shareable; when absent the
  // defaults apply in-memory (they are written to the URL only once the user edits a bound).
  const defaultFrom = useMemo(threeMonthsAgo, []);
  const defaultTo = useMemo(todayString, []);
  const from = searchParams.get('from') || defaultFrom;
  const to = searchParams.get('to') || defaultTo;

  useEffect(() => {
    if (projectId === null || !Number.isInteger(projectId)) {
      setLoadError('This project could not be found.');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    getProject(projectId)
      .then((row) => {
        if (!cancelled) setProject(row);
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load this project.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    listProjectTypes()
      .then(setTypes)
      .catch(() => setTypes([]));
  }, []);

  const typeLabel = useMemo(() => {
    if (!project) return '';
    return types.find((t) => t.id === project.type)?.label ?? project.type;
  }, [types, project]);

  function setRange(key: 'from' | 'to', value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  }

  async function applyStatus(override: StatusOverride) {
    if (!project) return;
    const previous = project;
    setActionError(null);
    setProject({
      ...project,
      status: optimisticStatus(project, override),
      end_date:
        override.end_date !== undefined ? override.end_date : project.end_date,
    });
    try {
      const saved = await updateProject(previous.id, toPayload(previous, override));
      setProject(saved);
    } catch {
      setProject(previous);
      setActionError('Could not update the project. Please try again.');
    }
  }

  if (loading) {
    return (
      <div>
        <p className="crumb num">
          <Link to="/projects">Projects</Link> / …
        </p>
        <p className="table-empty">Loading…</p>
      </div>
    );
  }

  if (loadError || !project) {
    return (
      <div>
        <p className="crumb num">
          <Link to="/projects">Projects</Link> / Not found
        </p>
        <p className="form-error" role="alert">
          {loadError ?? 'Could not load this project.'}
        </p>
      </div>
    );
  }

  const dateRange = `${formatMonthYear(project.start_date)} — ${
    project.end_date ? formatMonthYear(project.end_date) : 'ongoing'
  }`;
  const toggleLabel = project.status === 'active' ? 'Pause' : 'Resume';
  const toggleTo: ProjectStatus = project.status === 'active' ? 'paused' : 'active';
  const currency = project.rate_currency ?? 'CHF';
  const rateDisplay =
    project.rate_amount === null
      ? '—'
      : project.compensation_model === 'hourly'
        ? `${formatMoney(project.rate_amount, currency)}/h`
        : formatMoney(project.rate_amount, currency);

  return (
    <div>
      <p className="crumb num">
        <Link to="/projects">Projects</Link> / {project.name}
      </p>

      <div className="pd-head">
        <div>
          <h3>
            {project.name}
            <span className="status-pill">
              <StatusBadge status={project.status} />
            </span>
          </h3>
          <div className="pd-meta num">
            <span>{typeLabel}</span>
            <span className="sep">·</span>
            <span>{dateRange}</span>
            <span className="sep">·</span>
            <span>{compensationSummary(project)}</span>
            {project.tags.map((tag) => (
              <span className="tag" key={tag}>
                {tag}
              </span>
            ))}
          </div>
        </div>
        <div className="pd-actions">
          <Link className="btn ghost sm" to={`/projects/${project.id}/edit`}>
            Edit
          </Link>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => applyStatus({ status: toggleTo })}
          >
            {toggleLabel}
          </button>
          {confirmEnd ? (
            <span className="pd-confirm">
              <span>End this project?</span>
              <button
                type="button"
                className="btn ghost sm danger"
                onClick={() => {
                  void applyStatus({ end_date: todayString() });
                  setConfirmEnd(false);
                }}
              >
                End project
              </button>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => setConfirmEnd(false)}
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => setConfirmEnd(true)}
            >
              End project
            </button>
          )}
        </div>
      </div>

      {actionError && (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      )}

      <div className="range-filter">
        <span className="range-label">Showing</span>
        <label>
          From
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => setRange('from', e.target.value)}
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={to}
            min={from}
            onChange={(e) => setRange('to', e.target.value)}
          />
        </label>
      </div>

      <div className="cols">
        <div>
          <EntriesSection
            projectId={project.id}
            from={from}
            to={to}
            currency={currency}
          />
          <TimeLogsSection projectId={project.id} from={from} to={to} />
          {/* TODO(ticket 14): notes section mounts here */}
        </div>

        <div>
          <div className="panel">
            <div className="panel-h">
              <span className="t">Compensation</span>
            </div>
            <div className="panel-b kv" style={{ paddingTop: 6 }}>
              <div className="kvr">
                <span>Model</span>
                <b>{COMPENSATION_CONFIG[project.compensation_model].label}</b>
              </div>
              <div className="kvr">
                <span>Rate</span>
                <b>{rateDisplay}</b>
              </div>
              <div className="kvr">
                <span>Currency</span>
                <b>{project.rate_currency ?? '—'}</b>
              </div>
              <div className="kvr">
                <span>Started</span>
                <b>{formatFullDate(project.start_date)}</b>
              </div>
              <div className="kvr">
                <span>Ends</span>
                <b>{project.end_date ? formatFullDate(project.end_date) : '— ongoing'}</b>
              </div>
            </div>
          </div>
          {/* TODO(ticket 15): per-project metrics/chart — dashboard endpoint doesn't expose them yet */}
        </div>
      </div>
    </div>
  );
}
