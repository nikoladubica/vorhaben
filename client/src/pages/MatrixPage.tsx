// The Worth-It Matrix (breaktrough.md §2.6) — the product's signature screen. Two axes we already
// compute, crossed: effective hourly rate (X) against the feeling trend (Y), every active project a
// dot, dot area ∝ monthly hours, harsh-swing projects marked with a hairline ring. The quadrant
// stances are opinionated on purpose — the matrix is the product's point of view, not just a chart.
//
// Hand-rolled SVG in the Swiss token palette (no chart library — the design system IS the chart
// system). Position carries the meaning: no colour scale, no gradients, red stays reserved (a
// kill-candidate dot is grey; the LABEL delivers the verdict). Normalization is never re-derived
// here — the server pairs the canonical effective hourly rate with the mood-engine trend_score and
// hands over one payload (client/src/api/matrix.ts). Trend numbers stay internal; the Y axis shows
// only worded poles.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MatrixPayload, MatrixProject } from '../api/matrix';
import { getMatrix } from '../api/matrix';
import type { MoodEvent } from '../types';
import { listProjectMoods } from '../api/moods';
import { formatHours, formatMoney, formatRelativeTime } from '../domain/format';
import './matrix.css';

// ————— SVG geometry (viewBox coordinates; the plot scales with the container width) —————
const VB_W = 760;
const VB_H = 540;
const PLOT_L = 56;
const PLOT_T = 28;
const PLOT_R = 716;
const PLOT_B = 468;
const PLOT_W = PLOT_R - PLOT_L; // 660
const PLOT_H = PLOT_B - PLOT_T; // 440
const MID_X = PLOT_L + PLOT_W / 2; // 386

// Feeling-trend axis: trend_score runs roughly −5…+5, boundary at 0 (feels better ↑ / worse ↓).
const TREND_MIN = -5;
const TREND_MAX = 5;
const TREND_Y0 = PLOT_T + (1 - (0 - TREND_MIN) / (TREND_MAX - TREND_MIN)) * PLOT_H; // 248

// Dot radius clamp (in viewBox px); area ∝ hours ⇒ radius ∝ √hours.
const R_MIN = 7;
const R_MAX = 28;

// Quadrant boundary lines: --bar-mute is the token that reads a step above the --hairline frame.
const BOUNDARY = 'var(--bar-mute)';
const FRAME = 'var(--hairline)';

// confidence → the signal eyebrow's leading phrase (mirrors MoodSection). No days here — the matrix
// payload carries confidence, not the data span.
const CONFIDENCE_LABEL: Record<Exclude<MatrixProject['confidence'], 'none'>, string> = {
  early: 'Early signal',
  pattern: 'Pattern',
  established: 'Established trend',
};

interface Stance {
  title: string;
  note: string;
}

// 'excited' → 'Excited'; a cleared feeling reads as "Cleared" (matches MoodSection).
function feelingLabel(value: MoodEvent['value']): string {
  if (value === null) return 'Cleared';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// A project is plottable only when it has BOTH axes: an effective rate and a trend (confidence not
// 'none'). Honest absence beats fake placement.
function isPlottable(p: MatrixProject): p is MatrixProject & {
  effective_hourly_rate: number;
  trend_score: number;
} {
  return p.effective_hourly_rate !== null && p.trend_score !== null;
}

// The opinionated stance for a project's position. paysWell is portfolio-relative (vs the median);
// feelsGood is trend_score ≥ 0. Titles are the four fixed wordings from the report — never reworded.
function stanceFor(rate: number, trend: number, median: number | null): Stance {
  const paysWell = median !== null && rate >= median;
  const feelsGood = trend >= 0;
  const pays = paysWell ? 'Pays above your median' : 'Pays below your median';
  const feels =
    trend > 0.5
      ? 'feeling trending up'
      : trend < -0.5
        ? 'feeling trending down'
        : 'feeling holding flat';
  const note = `${pays} · ${feels}`;
  if (paysWell && feelsGood) return { title: 'Keep', note };
  if (!paysWell && feelsGood) return { title: 'Protected hobby', note };
  if (paysWell && !feelsGood) return { title: 'Cash cow — handle with care', note };
  return { title: 'Kill candidate', note };
}

// A short worded trend, with the swing amplitude appended when notable. Numbers never surface.
function trendPhrase(trend: number, swing: MatrixProject['swing']): string {
  const dir = trend > 0.5 ? 'Up' : trend < -0.5 ? 'Down' : 'Steady';
  const swingWord = swing === 'harsh' ? 'harsh swings' : swing === 'mild' ? 'mild swings' : null;
  return swingWord ? `${dir} · ${swingWord}` : dir;
}

// One project's fully-resolved render geometry — computed once, consumed by the SVG.
interface PlotDot {
  project: MatrixProject & { effective_hourly_rate: number; trend_score: number };
  cx: number;
  cy: number;
  r: number;
  harsh: boolean;
  anchorEnd: boolean;
  labelX: number;
  labelY: number;
  stance: Stance;
}

export function MatrixPage() {
  const [data, setData] = useState<MatrixPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getMatrix()
      .then((payload) => {
        if (cancelled) return;
        setData(payload);
        // Populate the panel by default so the signature screen never opens empty; pick the first
        // plottable project in the server's (name-ordered) list.
        const first = payload.projects.find(isPlottable);
        setSelectedId(first ? first.project_id : null);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load your matrix. Please try again.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const median = data?.median_rate ?? null;
  const ccy = data?.base_currency ?? '';

  const plottable = useMemo(() => (data ? data.projects.filter(isPlottable) : []), [data]);
  const unplottable = useMemo(
    () => (data ? data.projects.filter((p) => !isPlottable(p)) : []),
    [data],
  );

  // Rate domain from the plotted projects only (unplotted rates don't extend an axis they're absent
  // from), padded ~9% so edge dots aren't clipped. A single/flat portfolio gets a fixed pad.
  const domain = useMemo(() => {
    if (plottable.length === 0) return null;
    const rates = plottable.map((p) => p.effective_hourly_rate);
    const lo = Math.min(...rates);
    const hi = Math.max(...rates);
    const range = hi - lo;
    const pad = range > 0.001 ? range * 0.09 : Math.max(5, Math.abs(hi) * 0.15);
    return { lo, hi, min: lo - pad, max: hi + pad };
  }, [plottable]);

  const dots = useMemo<PlotDot[]>(() => {
    if (!domain) return [];
    const hMax = Math.max(...plottable.map((p) => p.monthly_hours), 0.0001);
    const xFor = (rate: number) =>
      PLOT_L + ((rate - domain.min) / (domain.max - domain.min)) * PLOT_W;
    const yFor = (trend: number) => {
      const clamped = Math.max(TREND_MIN, Math.min(TREND_MAX, trend));
      return PLOT_T + (1 - (clamped - TREND_MIN) / (TREND_MAX - TREND_MIN)) * PLOT_H;
    };
    return plottable.map((project) => {
      const cx = xFor(project.effective_hourly_rate);
      const cy = yFor(project.trend_score);
      const r = Math.max(R_MIN, Math.min(R_MAX, R_MAX * Math.sqrt(project.monthly_hours / hMax)));
      const harsh = project.swing === 'harsh';
      const anchorEnd = cx > MID_X; // labels lean toward the side with room
      const outer = Math.max(r + (harsh ? 5 : 0), project.project_id === selectedId ? r + 9 : 0);
      const gap = outer + 6;
      return {
        project,
        cx,
        cy,
        r,
        harsh,
        anchorEnd,
        labelX: anchorEnd ? cx - gap : cx + gap,
        labelY: cy + 4,
        stance: stanceFor(project.effective_hourly_rate, project.trend_score, median),
      };
    });
  }, [domain, plottable, median, selectedId]);

  // X ticks: the actual min / median / max rates (meaningful values, not the padded edges); a tick
  // is suppressed when it would collide with the emphasised median tick.
  const ticks = useMemo(() => {
    if (!domain || median === null) return [];
    const xFor = (rate: number) =>
      PLOT_L + ((rate - domain.min) / (domain.max - domain.min)) * PLOT_W;
    const medX = xFor(median);
    const out: { x: number; label: string; med: boolean }[] = [
      { x: medX, label: `${formatMoney(String(median), ccy)}`, med: true },
    ];
    if (Math.abs(xFor(domain.lo) - medX) >= 44)
      out.push({ x: xFor(domain.lo), label: formatMoney(String(domain.lo), ccy), med: false });
    if (Math.abs(xFor(domain.hi) - medX) >= 44)
      out.push({ x: xFor(domain.hi), label: formatMoney(String(domain.hi), ccy), med: false });
    return out;
  }, [domain, median, ccy]);

  const medianX =
    domain && median !== null
      ? PLOT_L + ((median - domain.min) / (domain.max - domain.min)) * PLOT_W
      : MID_X;

  const selected =
    data?.projects.find(
      (p): p is MatrixProject & { effective_hourly_rate: number; trend_score: number } =>
        p.project_id === selectedId && isPlottable(p),
    ) ?? null;

  const header = (
    <div className="dash-head">
      <h3>Worth-It Matrix</h3>
      {data && (
        <span className="period num">
          {new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })} · rate ×
          feeling
        </span>
      )}
    </div>
  );

  if (error) {
    return (
      <div>
        {header}
        <p className="form-error" role="alert">
          {error}
        </p>
      </div>
    );
  }

  if (!data) {
    return (
      <div>
        {header}
        <p className="table-empty">Loading…</p>
      </div>
    );
  }

  const activeCount = data.projects.length;
  const hasDots = dots.length > 0;
  const soloClass = selected ? '' : ' solo';

  return (
    <div className={loading ? 'dash-loading' : undefined}>
      {header}

      <div className={`mx-layout${soloClass}`}>
        <div className="mx-chartwrap">
          <div className="mx-chart-h">
            <span className="t">
              {hasDots
                ? `${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })} · ${dots.length} of ${activeCount} ${activeCount === 1 ? 'project' : 'projects'} plotted`
                : 'Your matrix'}
            </span>
            <span className="s num">
              {median !== null
                ? `base currency ${ccy} · median rate ${formatMoney(String(median), ccy)}/h`
                : 'nothing plotted yet'}
            </span>
          </div>

          <div className="mx-scroll">
            <figure
              className="mx-fig"
              aria-label="Two-by-two matrix of active projects. Horizontal axis is effective hourly rate (pays better rightward); vertical axis is feeling trend (feels better upward). Dot size tracks monthly hours; a ring marks harsh mood swings."
            >
              <svg className="mx-plot" viewBox={`0 0 ${VB_W} ${VB_H}`} width="100%" role="img">
                {/* frame */}
                <rect
                  x={PLOT_L}
                  y={PLOT_T}
                  width={PLOT_W}
                  height={PLOT_H}
                  fill="none"
                  stroke={FRAME}
                  strokeWidth={1}
                />
                {/* quadrant boundaries: median rate (vertical) + trend 0 (horizontal) */}
                <line
                  x1={medianX}
                  y1={PLOT_T}
                  x2={medianX}
                  y2={PLOT_B}
                  stroke={BOUNDARY}
                  strokeWidth={1}
                />
                <line
                  x1={PLOT_L}
                  y1={TREND_Y0}
                  x2={PLOT_R}
                  y2={TREND_Y0}
                  stroke={BOUNDARY}
                  strokeWidth={1}
                />
                {median !== null && (
                  <text className="mx-medlbl" x={medianX + 5} y={PLOT_T + 14}>
                    Median · pays well →
                  </text>
                )}

                {/* quadrant stances — opinionated labels in each outer corner */}
                <text className="mx-stance" x={PLOT_L + 14} y={PLOT_T + 24} textAnchor="start">
                  Protected hobby
                </text>
                <text className="mx-sub" x={PLOT_L + 14} y={PLOT_T + 40} textAnchor="start">
                  It doesn’t owe you money.
                </text>

                <text className="mx-stance" x={PLOT_R - 14} y={PLOT_T + 24} textAnchor="end">
                  Keep
                </text>
                <text className="mx-sub" x={PLOT_R - 14} y={PLOT_T + 40} textAnchor="end">
                  The portfolio core.
                </text>

                <text className="mx-stance" x={PLOT_L + 14} y={PLOT_B - 38} textAnchor="start">
                  Kill candidate
                </text>
                <text className="mx-sub" x={PLOT_L + 14} y={PLOT_B - 22} textAnchor="start">
                  Why is this still here?
                </text>

                <text className="mx-stance" x={PLOT_R - 14} y={PLOT_B - 38} textAnchor="end">
                  Cash cow — handle with care
                </text>
                <text className="mx-sub" x={PLOT_R - 14} y={PLOT_B - 22} textAnchor="end">
                  Milk it, contain it, or raise the rate.
                </text>

                {/* Y poles: worded only, never numbers */}
                <text
                  className="mx-pole"
                  x={22}
                  y={PLOT_T + 110}
                  textAnchor="middle"
                  transform={`rotate(-90 22 ${PLOT_T + 110})`}
                >
                  Feels better
                </text>
                <text
                  className="mx-pole"
                  x={22}
                  y={PLOT_B - 108}
                  textAnchor="middle"
                  transform={`rotate(-90 22 ${PLOT_B - 108})`}
                >
                  Feels worse
                </text>

                {/* X ticks: sparse rate ticks (min / median / max) */}
                {ticks.map((t) => (
                  <g key={`${t.med ? 'med' : 'tick'}-${Math.round(t.x)}`}>
                    <line
                      x1={t.x}
                      y1={PLOT_B}
                      x2={t.x}
                      y2={PLOT_B + 6}
                      stroke={t.med ? BOUNDARY : FRAME}
                    />
                    <text
                      className={t.med ? 'mx-tickv med' : 'mx-tickv'}
                      x={t.x}
                      y={PLOT_B + 20}
                      textAnchor="middle"
                    >
                      {t.label}
                    </text>
                  </g>
                ))}
                <text className="mx-axis" x={MID_X} y={PLOT_B + 50} textAnchor="middle">
                  Effective hourly rate →
                </text>

                {/* dots — area ∝ monthly hours; a kill-candidate dot is never red */}
                {dots.map((d) => {
                  const isSel = d.project.project_id === selectedId;
                  const label = `${d.project.name}. ${d.stance.title}. ${formatMoney(String(d.project.effective_hourly_rate), ccy)} per hour, ${formatHours(String(d.project.monthly_hours))} hours per month${d.harsh ? ', harsh mood swings' : ''}.`;
                  return (
                    <g key={d.project.project_id}>
                      {isSel && <circle className="mx-halo" cx={d.cx} cy={d.cy} r={d.r + 9} />}
                      {d.harsh && <circle className="mx-ring" cx={d.cx} cy={d.cy} r={d.r + 5} />}
                      <circle
                        className={isSel ? 'mx-dot sel' : 'mx-dot'}
                        cx={d.cx}
                        cy={d.cy}
                        r={d.r}
                        role="button"
                        tabIndex={0}
                        aria-pressed={isSel}
                        aria-label={label}
                        onClick={() => setSelectedId(d.project.project_id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setSelectedId(d.project.project_id);
                          }
                        }}
                      >
                        <title>{label}</title>
                      </circle>
                      <text
                        className={isSel ? 'mx-name sel' : 'mx-name'}
                        x={d.labelX}
                        y={d.labelY}
                        textAnchor={d.anchorEnd ? 'end' : 'start'}
                      >
                        {d.project.name}
                      </text>
                    </g>
                  );
                })}

                {/* fresh / low-data: the framed point of view still renders */}
                {!hasDots && (
                  <>
                    <text className="mx-empty" x={MID_X} y={TREND_Y0 - 8} textAnchor="middle">
                      This is where your projects will sit.
                    </text>
                    <text className="mx-sub" x={MID_X} y={TREND_Y0 + 14} textAnchor="middle">
                      Log a rate and a few feelings to place your first dot.
                    </text>
                  </>
                )}
              </svg>
            </figure>
          </div>

          {hasDots && (
            <div className="mx-legend" aria-hidden="true">
              <span className="li">
                <svg width="34" height="20" viewBox="0 0 34 20">
                  <circle cx="8" cy="10" r="4" fill="var(--bar-mute)" />
                  <circle cx="24" cy="10" r="8" fill="var(--bar-mute)" />
                </svg>
                Dot size = hours per month
              </span>
              <span className="li">
                <svg width="20" height="20" viewBox="0 0 20 20">
                  <circle cx="10" cy="10" r="8" fill="none" stroke="var(--ink-3)" />
                  <circle cx="10" cy="10" r="4" fill="var(--bar-mute)" />
                </svg>
                Ring = harsh mood swings
              </span>
            </div>
          )}

          {/* honest absence: unplottable projects listed, never faked onto the grid */}
          {unplottable.length > 0 && (
            <div className="mx-missing">
              <span className="k">Not enough data yet</span>
              <p>
                <b>{unplottable.map((p) => p.name).join(', ')}</b> — no effective rate or not enough
                mood readings. Log time or a feeling to place{' '}
                {unplottable.length === 1 ? 'it' : 'them'} on the matrix.
              </p>
            </div>
          )}

          {dots.length < 2 && (
            <div className="mx-missing">
              <span className="k">{hasDots ? 'One more to compare' : 'Waiting on data'}</span>
              <p>
                The matrix fills in once at least{' '}
                <b>two projects have an effective rate and a few mood readings</b>. The four stances
                stay on screen either way — they’re the promise, not the payoff.
              </p>
            </div>
          )}
        </div>

        {selected && (
          <MatrixSidePanel key={selected.project_id} project={selected} median={median} ccy={ccy} />
        )}
      </div>
    </div>
  );
}

interface MatrixSidePanelProps {
  project: MatrixProject & { effective_hourly_rate: number; trend_score: number };
  median: number | null;
  ccy: string;
}

// The click-through panel: the selected project's stance, its First Signal sentence, the rate/hours
// pairing, and its mood stream (the ticket-01 history list) — plus a link to the project page.
function MatrixSidePanel({ project, median, ccy }: MatrixSidePanelProps) {
  const [events, setEvents] = useState<MoodEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    listProjectMoods(project.project_id, 10)
      .then((rows) => {
        if (!cancelled) setEvents(rows);
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load the mood history.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project.project_id]);

  const stance = stanceFor(project.effective_hourly_rate, project.trend_score, median);

  return (
    <aside className="mx-side" aria-label="Selected project">
      <div className="mx-side-h">
        <h4>
          {project.name}
          <span className="status-pill">
            <span className="dot g"></span>Active
          </span>
        </h4>
        <span className="stance">
          {stance.title}
          <small>{stance.note}</small>
        </span>
      </div>

      {project.sentence && project.confidence !== 'none' && (
        <div className="mx-signal">
          <span className="k">{CONFIDENCE_LABEL[project.confidence]}</span>
          <p>{project.sentence}</p>
        </div>
      )}

      <div className="mx-side-b">
        <div className="mx-sec-lbl">Rate &amp; hours</div>
        <div className="kv">
          <div className="kvr">
            <span>Effective rate</span>
            <b className="num">{formatMoney(String(project.effective_hourly_rate), ccy)}/h</b>
          </div>
          <div className="kvr">
            <span>Hours this month</span>
            <b className="num">{formatHours(String(project.monthly_hours))} h</b>
          </div>
          <div className="kvr">
            <span>Feeling trend</span>
            <b>{trendPhrase(project.trend_score, project.swing)}</b>
          </div>
        </div>

        <div className="mx-sec-lbl mt">Mood stream</div>
        {loading ? (
          <p className="table-empty">Loading…</p>
        ) : loadError ? (
          <p className="form-error" role="alert">
            {loadError}
          </p>
        ) : events.length === 0 ? (
          <p className="table-empty">No mood logged yet.</p>
        ) : (
          <div className="mstream">
            {events.map((ev) => (
              <div key={ev.id} className="mev">
                <span className="mf">{feelingLabel(ev.value)}</span>
                <span className="mw">{formatRelativeTime(ev.created_at)}</span>
                {ev.note && <span className="mn">{ev.note}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mx-side-foot">
        <Link className="btn ghost sm" to={`/projects/${project.project_id}`}>
          Open {project.name} →
        </Link>
      </div>
    </aside>
  );
}
