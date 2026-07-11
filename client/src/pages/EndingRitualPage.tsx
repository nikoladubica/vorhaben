// The ending ritual (breaktrough.md §2.7 / ticket 06, step 4). Ending a project is a feature, not
// a failure — so this is a full-screen statement fragment, NOT a confirm dialog. It reads back what
// the project earned over its life, the hours it took (honestly labelled as a windowed figure —
// there is no all-time-hours number), and its mood over time as a small dotted spark. One optional
// field asks "what did it teach you?" and files into `ending_note`. Nothing is red except the single
// primary action and the current-mood dot; there is no "are you sure".
//
// The status write is the ONE existing path: a single updateProject PATCH that sets end_date = today
// (the server derives `ended`) AND ending_note. On success the form region is replaced in place with
// a confirmation — the figures stay on screen; we do not navigate away.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Feeling, MoodEvent, Project, ProjectMetrics, ProjectPayload } from '../types';
import { getProject, getProjectMetrics, updateProject } from '../api/projects';
import { listProjectMoods } from '../api/moods';
import { formatMoney, todayString } from '../domain/format';
import './ending.css';

const wordmark = (
  <span className="wordmark">
    <span className="sq" aria-hidden="true"></span>VORHABEN
  </span>
);

// Whole-unit money, matching the project page ("CHF 1'850"); an em dash when the figure is null.
function money(value: number | null, currency: string): string {
  return value === null ? '—' : formatMoney(String(Math.round(value)), currency);
}

// Rebuild the full write payload from the loaded project, then overlay the ending. `ended` is a
// derived status, so we never send it: end_date = today lets the server derive it. Mirrors the
// project-detail toPayload so the two write paths stay identical.
function endingPayload(project: Project, endingNote: string): ProjectPayload {
  return {
    name: project.name,
    type: project.type,
    description: project.description,
    status: project.status === 'ended' ? 'active' : project.status,
    start_date: project.start_date,
    end_date: todayString(),
    compensation_model: project.compensation_model,
    rate_amount: project.rate_amount === null ? null : Number(project.rate_amount),
    rate_currency: project.rate_currency,
    tags: project.tags,
    ending_note: endingNote.trim() || null,
  };
}

export function EndingRitualPage() {
  const { id } = useParams();
  const projectId = id ? Number(id) : null;

  const [project, setProject] = useState<Project | null>(null);
  const [metrics, setMetrics] = useState<ProjectMetrics | null>(null);
  const [moods, setMoods] = useState<MoodEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [note, setNote] = useState('');
  const [ending, setEnding] = useState(false);
  const [ended, setEnded] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (projectId === null || !Number.isInteger(projectId)) {
      setLoadError('This project could not be found.');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    Promise.all([
      getProject(projectId),
      getProjectMetrics(projectId).catch(() => null),
      listProjectMoods(projectId, 200).catch(() => []),
    ])
      .then(([row, m, events]) => {
        if (cancelled) return;
        setProject(row);
        setMetrics(m);
        setMoods(events);
        setNote(row.ending_note ?? '');
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

  const endProject = useCallback(async () => {
    if (!project || ending) return;
    setEnding(true);
    setSaveError(null);
    try {
      const saved = await updateProject(project.id, endingPayload(project, note));
      setProject(saved);
      setEnded(true);
    } catch {
      setSaveError('Could not end the project. Please try again.');
    } finally {
      setEnding(false);
    }
  }, [project, note, ending]);

  if (loading) {
    return (
      <main className="ending-stage">
        <div className="ending-shell">
          <div className="ending-top">{wordmark}</div>
          <p className="ending-kicker">Ending a project</p>
          <p className="ending-empty">Loading…</p>
        </div>
      </main>
    );
  }

  if (loadError || !project) {
    return (
      <main className="ending-stage">
        <div className="ending-shell">
          <div className="ending-top">
            {wordmark}
            <Link className="ending-exit" to="/projects">
              Back to projects
            </Link>
          </div>
          <p className="ending-kicker">Ending a project</p>
          <p className="form-error" role="alert">
            {loadError ?? 'Could not load this project.'}
          </p>
        </div>
      </main>
    );
  }

  const currency = metrics?.base_currency ?? project.rate_currency ?? 'CHF';
  const windowMonths = metrics?.window_months ?? 0;
  const windowedHours = metrics ? Math.round(metrics.hours_in_window) : 0;

  return (
    <main className="ending-stage">
      <div className="ending-shell">
        <div className="ending-top">
          {wordmark}
          <Link className="ending-exit" to={`/projects/${project.id}`}>
            Back to project
          </Link>
        </div>

        <p className="ending-kicker">Ending a project</p>
        <h1 className="ending-name">{project.name}</h1>
        <p className="ending-lede">
          A finished undertaking, not a failure. Here is what it came to.
        </p>

        <section className="ending-statement">
          <div className="ending-figures">
            <div className="ending-fig">
              <span className="ending-fig-k">Earned over its life</span>
              <span className="ending-fig-v num">
                {metrics ? money(metrics.total_revenue, currency) : '—'}
              </span>
            </div>
            <div className="ending-fig">
              <span className="ending-fig-k">Effective rate</span>
              <span className="ending-fig-v num">
                {metrics && metrics.effective_hourly_rate !== null
                  ? `${money(metrics.effective_hourly_rate, currency)}/h`
                  : '—'}
              </span>
            </div>
            <div className="ending-fig">
              <span className="ending-fig-k">Hours</span>
              <span className="ending-fig-v num">{metrics ? `${windowedHours} h` : '—'}</span>
              <span className="ending-fig-s">
                {metrics ? `in its last ${windowMonths}-month window` : ''}
              </span>
            </div>
          </div>

          <div className="ending-spark">
            <span className="ending-spark-k">How it felt over time</span>
            <MoodSpark moods={moods} />
          </div>
        </section>

        {ended ? (
          <section className="ending-done">
            <h2 className="ending-done-t">Ended. It stays in your history.</h2>
            <p className="ending-done-s">
              Nothing is lost — you can reactivate it any time from the projects list.
            </p>
            <div className="ending-done-actions">
              <Link className="ending-back-link" to={`/projects/${project.id}`}>
                Back to project
              </Link>
              <Link className="ending-back-link" to="/projects">
                See it in your history
              </Link>
            </div>
          </section>
        ) : (
          <section className="ending-form">
            <label className="field ending-note">
              <span>What did it teach you?</span>
              <textarea
                rows={3}
                maxLength={1000}
                value={note}
                placeholder="Optional — a line for future you."
                onChange={(e) => setNote(e.target.value)}
              />
            </label>

            {saveError && (
              <p className="form-error ending-save-error" role="alert">
                {saveError}
              </p>
            )}

            <button type="button" className="cta" onClick={() => void endProject()} disabled={ending}>
              {ending ? 'Ending…' : 'End project'}
            </button>
          </section>
        )}
      </div>
    </main>
  );
}

// The mood spark — a hand-rolled dotted SVG of the project's mood over its life (§2.7). DOTS, not a
// connecting line: a `null` value plots NO dot (a gap is honoured, never coerced to zero). Grey dots
// with a single hairline zero-rule; the most-recent dot is red with a --surface halo so it lifts off
// the rule. No axes, ticks, or numbers. 0 dots → a quiet empty line; 1 dot → a single centred red dot.
const VALENCE: Record<Feeling, number> = {
  excited: 2,
  happy: 2,
  grateful: 2,
  opportunistic: 1,
  pessimistic: -1,
  stressed: -1,
  sad: -2,
  miserable: -2,
};

// Viewport of the spark. A wide, short strip that scales to the container while keeping dots round
// (uniform scaling via width:100%/height:auto in CSS on a fixed viewBox).
const W = 480;
const H = 56;
const PAD_X = 10;
const PAD_Y = 10;

function MoodSpark({ moods }: { moods: MoodEvent[] }) {
  // Chronological (the API returns newest-first); each event keeps its slot so gaps stay visible.
  const points = useMemo(() => {
    const chrono = [...moods].reverse();
    const n = chrono.length;
    const innerW = W - PAD_X * 2;
    const innerH = H - PAD_Y * 2;
    const xFor = (i: number) => (n <= 1 ? W / 2 : PAD_X + (i / (n - 1)) * innerW);
    // valence 2 → top, −2 → bottom; 0 → the zero-rule (middle).
    const yFor = (v: number) => PAD_Y + (1 - (v + 2) / 4) * innerH;
    return chrono
      .map((m, i) => (m.value === null ? null : { x: xFor(i), y: yFor(VALENCE[m.value]) }))
      .filter((p): p is { x: number; y: number } => p !== null);
  }, [moods]);

  const zeroY = PAD_Y + (H - PAD_Y * 2) / 2;
  const total = points.length;
  const label =
    total === 0
      ? 'No moods logged over its life'
      : `Mood over its life, ${total} ${total === 1 ? 'check-in' : 'check-ins'}`;

  return (
    <svg className="mood-spark" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      {/* the single hairline zero-rule — also the "quiet empty line" when there are no dots */}
      <line x1={PAD_X} y1={zeroY} x2={W - PAD_X} y2={zeroY} className="mood-spark-zero" />
      {points.map((p, i) => {
        const isLatest = i === total - 1;
        if (isLatest) {
          return (
            <g key={i}>
              <circle cx={p.x} cy={p.y} r={6} className="mood-spark-halo" />
              <circle cx={p.x} cy={p.y} r={3.5} className="mood-spark-now" />
            </g>
          );
        }
        return <circle key={i} cx={p.x} cy={p.y} r={3} className="mood-spark-dot" />;
      })}
    </svg>
  );
}
