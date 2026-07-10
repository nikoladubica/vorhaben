// Public, unauthenticated "try the canvas" demo (linked from the landing page). It reuses the exact
// CanvasBoardView + cards + pickers from the authed /canvas, but persists to localStorage instead of
// the API — no network, no DB, no auth. A scratch board that lives only in this browser: add a few
// demo projects, drag them onto the squares, tag how each feels and how it's going. Demo cards carry
// no real metrics, so the money line is hidden and the note chips are plain (no project route).

import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { CanvasItem, Feeling, Trend } from '../types';
import { CanvasBoardView } from '../components/canvas/CanvasBoardView';
import './canvas.css';

const STORAGE_KEY = 'vorhaben:canvas-demo:v1';

// The 12 project type labels, hardcoded client-side (the demo never calls the API).
const TYPE_LABELS = [
  'Job',
  'Freelance Gig',
  'Freelance Client',
  'Contract',
  'Project',
  'Commission',
  'Margin',
  'Loan Interest',
  'Stock',
  'Dividend',
  'Product',
  'Other',
] as const;

// A demo project — the throwaway localStorage record. `id` is a monotonic counter; `files` holds the
// names of attached .md files (rendered as plain chips, since there's no note view in the demo).
interface DemoProject {
  id: number;
  name: string;
  type_label: string;
  feeling: Feeling | null;
  trend: Trend | null;
  placed: boolean;
  x?: number;
  y?: number;
  files: string[];
}

// Load persisted demo projects, guarding against malformed JSON → start empty.
function loadProjects(): DemoProject[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DemoProject[]) : [];
  } catch {
    return [];
  }
}

// Map a demo project onto the CanvasItem shape the board expects. No real metrics — money figures
// are null and hidden by `hideValue`; `note_count` drives the (plain) chips.
function toItem(p: DemoProject): CanvasItem {
  return {
    project_id: p.id,
    name: p.name,
    type: p.type_label,
    type_label: p.type_label,
    status: 'active',
    feeling: p.feeling,
    trend: p.trend,
    note_count: p.files.length,
    monthly_revenue: null,
    effective_hourly_rate: null,
    base_currency: '',
    x: p.x,
    y: p.y,
  };
}

export function TryCanvasPage() {
  const [projects, setProjects] = useState<DemoProject[]>(loadProjects);
  const [name, setName] = useState('');
  const [typeLabel, setTypeLabel] = useState<string>(TYPE_LABELS[0]);
  // Inline per-card message (a rejected non-Markdown drop), per project. Transient — not persisted.
  const [cardErrors, setCardErrors] = useState<Record<number, string | null>>({});

  // Persist on every change.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
    } catch {
      // Storage full or unavailable — the demo simply won't persist; nothing else to do.
    }
  }, [projects]);

  const placed = useMemo(() => projects.filter((p) => p.placed).map(toItem), [projects]);
  const tray = useMemo(() => projects.filter((p) => !p.placed).map(toItem), [projects]);
  const fileChips = useMemo<Record<number, string[]>>(
    () => Object.fromEntries(projects.map((p) => [p.id, p.files])),
    [projects],
  );

  function patch(id: number, patchFn: (p: DemoProject) => DemoProject) {
    setProjects((prev) => prev.map((p) => (p.id === id ? patchFn(p) : p)));
  }

  function setCardError(id: number, message: string | null) {
    setCardErrors((prev) => ({ ...prev, [id]: message }));
  }

  function handleAdd(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const nextId = projects.reduce((max, p) => Math.max(max, p.id), 0) + 1;
    setProjects((prev) => [
      ...prev,
      { id: nextId, name: trimmed, type_label: typeLabel, feeling: null, trend: null, placed: false, files: [] },
    ]);
    setName('');
  }

  function handleReset() {
    if (!window.confirm('Clear this demo board? This removes every demo project from this browser.')) {
      return;
    }
    setProjects([]);
    setCardErrors({});
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore — state is already cleared
    }
  }

  // ————— board handlers (all local; no network) —————

  function handlePlace(id: number, x: number, y: number) {
    patch(id, (p) => ({ ...p, placed: true, x, y }));
  }

  function handleRemove(id: number) {
    patch(id, (p) => ({ ...p, placed: false, x: undefined, y: undefined }));
  }

  function handleFeeling(id: number, feeling: Feeling | null) {
    patch(id, (p) => ({ ...p, feeling }));
    setCardError(id, null);
  }

  function handleTrend(id: number, trend: Trend | null) {
    patch(id, (p) => ({ ...p, trend }));
    setCardError(id, null);
  }

  function handleDropMarkdown(id: number, file: File) {
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.md') && !lower.endsWith('.markdown')) {
      setCardError(id, 'Only Markdown files can be attached.');
      return;
    }
    setCardError(id, null);
    patch(id, (p) => ({ ...p, files: [...p.files, file.name] }));
  }

  return (
    <div className="demo">
      <header className="demo-top">
        <Link className="wordmark" to="/">
          <span className="sq" aria-hidden="true"></span>VORHABEN
        </Link>
        <Link className="demo-home" to="/">
          ← Home
        </Link>
        <Link className="ld-top-cta demo-start" to="/register">
          Start free
        </Link>
      </header>

      <main className="demo-main">
        <div className="dash-head">
          <h3>Canvas — try it</h3>
        </div>

        <div className="panel">
          <div className="cv-promo">
            <span className="k">Canvas — try it</span>
            <p>
              This is a scratch board saved only in this browser. Add a few projects, drag them onto
              the squares, tag how each feels and how it’s going. Nothing is sent anywhere.
            </p>
          </div>

          <form className="demo-add" onSubmit={handleAdd}>
            <div className="demo-field">
              <label htmlFor="demo-name">Project name</label>
              <input
                id="demo-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Studio K"
                autoComplete="off"
              />
            </div>
            <div className="demo-field">
              <label htmlFor="demo-type">Type</label>
              <select
                id="demo-type"
                value={typeLabel}
                onChange={(e) => setTypeLabel(e.target.value)}
              >
                {TYPE_LABELS.map((label) => (
                  <option key={label} value={label}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="demo-btn" disabled={!name.trim()}>
              Add project
            </button>
            <button
              type="button"
              className="demo-btn ghost"
              onClick={handleReset}
              disabled={projects.length === 0}
            >
              Reset
            </button>
          </form>

          {projects.length === 0 ? (
            <div className="cv-body">
              <aside className="cv-tray">
                <span className="t">Not on the board</span>
                <p className="hint">Add a project above to start.</p>
              </aside>
              <div className="cv-board" aria-label="Project canvas">
                <p className="board-empty">Add a project above, then drag it onto the squares.</p>
              </div>
            </div>
          ) : (
            <CanvasBoardView
              placed={placed}
              tray={tray}
              hideValue
              chipTo={() => null}
              fileChips={fileChips}
              cardErrors={cardErrors}
              onPlace={handlePlace}
              onRemove={handleRemove}
              onFeeling={handleFeeling}
              onTrend={handleTrend}
              onDropMarkdown={handleDropMarkdown}
            />
          )}
        </div>

        <p className="demo-foot">
          Like it?{' '}
          <Link to="/register">Start free</Link> to track real income across every project.
        </p>
      </main>
    </div>
  );
}
