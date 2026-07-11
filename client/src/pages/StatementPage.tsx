// The Quarterly Statement (breaktrough.md §2.8 / ticket 07) — the product's most designed artifact:
// a private-bank-style statement of one quarter, computed on demand and rendered print-quality. One
// ~820px column, red spent exactly twice (the head wordmark square and the single recommendation's
// focus rule); everything else is achromatic so it survives a black-and-white print. The screen
// chrome (topbar + period picker + print button) is `.stmt-chrome` and vanishes under @media print,
// leaving a clean A4 out of the same DOM (statement.css). Money arrives base-currency-converted from
// the server; null figures render as an em dash — we never fabricate a value the API omits.

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api';
import type {
  Statement,
  StatementAggregates,
  StatementPeriod,
  StatementPortfolioProject,
  TrajectoryPoint,
} from '../api/statement';
import { getStatement, getStatementPeriods } from '../api/statement';
import { useAuth } from '../auth/useAuth';
import { formatFullDate, formatHours, formatMoney } from '../domain/format';
import './statement.css';

// Two initials for the account avatar, mirroring AppLayout's rule.
function initials(email: string): string {
  const local = email.split('@')[0] ?? '';
  const parts = local.split(/[._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0][0] + parts[1][0] : local.slice(0, 2);
  return letters.toUpperCase() || '?';
}

// A base-currency figure → Swiss display, or an em dash when the API omits it.
function money(value: number | null, ccy: string): string {
  return value === null ? '—' : formatMoney(String(value), ccy);
}

// A direction → the verdict/trend glyph + word (achromatic; the glyph carries the read, not colour).
const DIRECTION: Record<'up' | 'down' | 'flat', string> = {
  up: '▲ Rising',
  down: '▼ Cooling',
  flat: '▬ Steady',
};

// "2026-04-01" + "2026-06-30" → "1 April – 30 June 2026" for the head. Parsed as UTC to dodge a
// timezone off-by-one on the day number.
function headRange(from: string, to: string): string {
  const f = new Date(`${from}T00:00:00Z`);
  const t = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) return `${from} – ${to}`;
  const day = (d: Date) => d.getUTCDate();
  const month = (d: Date) => d.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  const yf = f.getUTCFullYear();
  const yt = t.getUTCFullYear();
  if (yf === yt) return `${day(f)} ${month(f)} – ${day(t)} ${month(t)} ${yt}`;
  return `${day(f)} ${month(f)} ${yf} – ${day(t)} ${month(t)} ${yt}`;
}

// The prose lede: one warm, Swiss sentence assembled from the net figure and the quarter-over-quarter
// direction. No numbers we don't have — a null net simply reads as "still taking shape".
function ledeSentence(agg: StatementAggregates, ccy: string): string {
  const { total_monthly_net: net, prev_monthly_net: prev, trend_direction: dir } = agg;
  if (net === null) return 'The quarter’s figures are still taking shape.';
  const verb =
    dir === 'up' ? 'rose to' : dir === 'down' ? 'eased to' : dir === 'flat' ? 'held at' : 'came to';
  let s = `Your monthly-equivalent net ${verb} ${money(net, ccy)}`;
  if (prev !== null) {
    const link = dir === 'up' ? 'up from' : dir === 'down' ? 'down from' : 'against';
    s += `, ${link} ${money(prev, ccy)} the quarter before.`;
  } else {
    s += ' this quarter.';
  }
  return s;
}

// The mood sparkline (spec §Sparkline): viewBox 0 0 88 22, padding 3 ⇒ 82×16 usable. valence −2…+2
// maps to y so +2 sits at the top. Null valences are gaps — the line splits around them; isolated
// valued readings get a dot, and the last valued reading gets the "Now" marker. N<2 renders nothing.
const SP_P = 3;
const SP_W = 82;
const SP_H = 16;

function Sparkline({ trajectory }: { trajectory: TrajectoryPoint[] }) {
  const n = trajectory.length;
  if (n < 2) return null;

  const xAt = (i: number) => SP_P + (i * SP_W) / (n - 1);
  const yAt = (v: number) => SP_P + ((2 - v) / 4) * SP_H;

  // Contiguous runs of valued readings; a gap (null valence) breaks the current run.
  const segments: { x: number; y: number }[][] = [];
  let run: { x: number; y: number }[] = [];
  const valued: { x: number; y: number }[] = [];
  trajectory.forEach((pt, i) => {
    if (pt.valence === null || pt.valence === undefined) {
      if (run.length) {
        segments.push(run);
        run = [];
      }
      return;
    }
    const p = { x: xAt(i), y: yAt(pt.valence) };
    run.push(p);
    valued.push(p);
  });
  if (run.length) segments.push(run);

  const first = valued[0];
  const last = valued[valued.length - 1];
  const label =
    first && last
      ? last.y < first.y
        ? 'Mood trajectory: rising'
        : last.y > first.y
          ? 'Mood trajectory: cooling'
          : 'Mood trajectory: steady'
      : 'Mood trajectory: steady';

  return (
    <svg className="stmt-spark" viewBox="0 0 88 22" width="88" height="22" role="img" aria-label={label}>
      <line x1={SP_P} y1={11} x2={85} y2={11} stroke="var(--grid)" strokeWidth={1} />
      {segments.map((seg, i) =>
        seg.length >= 2 ? (
          <polyline
            key={`seg-${i}`}
            points={seg.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke="var(--ink-2)"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <circle key={`seg-${i}`} cx={seg[0].x} cy={seg[0].y} r={1.5} fill="var(--ink-2)" />
        ),
      )}
      {last && <circle cx={last.x} cy={last.y} r={2} fill="var(--ink)" />}
    </svg>
  );
}

// One portfolio row. Money/hours are right-aligned tabular figures; a negative net keeps its leading
// minus but never turns red. The verdict cell degrades to an em dash and appends a harsh-swing tag.
function PortfolioRow({ p, ccy }: { p: StatementPortfolioProject; ccy: string }) {
  const active = p.status === 'active';
  const statusLabel = p.status.charAt(0).toUpperCase() + p.status.slice(1);
  const dir = p.verdict?.direction ?? null;
  const hasVerdict = dir !== null || p.harsh_swing;

  return (
    <tr>
      <td>
        <span className="stmt-proj">
          {p.name}
          <small>{p.type}</small>
        </span>
      </td>
      <td>
        <span className="stmt-status">
          <span className={`dot ${active ? 'g' : 'p'}`} aria-hidden="true"></span>
          {statusLabel}
        </span>
      </td>
      <td className={`r${p.monthly_net !== null && p.monthly_net < 0 ? ' stmt-neg' : ''}`}>
        {money(p.monthly_net, ccy)}
      </td>
      <td className="r">{p.effective_hourly_rate === null ? '—' : `${money(p.effective_hourly_rate, ccy)}/h`}</td>
      <td className="r">{p.hours === null ? '—' : `${formatHours(String(p.hours))} h`}</td>
      <td className="r">{money(p.total_revenue, ccy)}</td>
      <td>{p.trajectory.length >= 2 ? <Sparkline trajectory={p.trajectory} /> : null}</td>
      <td>
        {hasVerdict ? (
          <span className="stmt-verdict" title={p.verdict?.sentence}>
            {dir ? DIRECTION[dir] : null}
            {p.harsh_swing ? <small>HARSH SWINGS</small> : null}
          </span>
        ) : (
          '—'
        )}
      </td>
    </tr>
  );
}

export function StatementPage() {
  const { period } = useParams<{ period: string }>();
  const navigate = useNavigate();
  const auth = useAuth();
  const email = auth.status === 'user' ? auth.user.email : '';

  const [statement, setStatement] = useState<Statement | null>(null);
  const [periods, setPeriods] = useState<StatementPeriod[]>([]);
  const [state, setState] = useState<'loading' | 'ok' | 'notfound' | 'error'>('loading');

  useEffect(() => {
    getStatementPeriods()
      .then((res) => setPeriods(res.periods))
      .catch(() => setPeriods([]));
  }, []);

  useEffect(() => {
    if (!period) {
      setState('notfound');
      return;
    }
    let cancelled = false;
    setState('loading');
    getStatement(period)
      .then((data) => {
        if (cancelled) return;
        setStatement(data);
        setState('ok');
      })
      .catch((err) => {
        if (cancelled) return;
        setState(err instanceof ApiError && err.status === 404 ? 'notfound' : 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [period]);

  // The screen-only chrome: the standard topbar (Dashboard stays the active tab) plus the period
  // picker and a print action. Hidden entirely under @media print.
  const chrome = (
    <div className="stmt-chrome">
      <div className="topbar">
        <div className="topbar-inner">
          <Link className="wordmark" to="/">
            <span className="sq" aria-hidden="true"></span>VORHABEN
          </Link>
          <nav className="main" aria-label="Primary">
            <Link to="/" className="on" aria-current="page">
              Dashboard
            </Link>
            <Link to="/projects">Projects</Link>
            <Link to="/matrix">Matrix</Link>
            <Link to="/notes">Notes</Link>
          </nav>
          <div className="account">
            <Link to="/settings" className="me" aria-label={`Account settings for ${email}`} title={email}>
              {initials(email)}
            </Link>
          </div>
        </div>
      </div>

      <div className="stmt-actions">
        <label className="stmt-picker">
          <span className="stmt-picker-lbl">Quarter</span>
          <select
            className="stmt-select"
            value={period ?? ''}
            onChange={(e) => navigate(`/statement/${e.target.value}`)}
            aria-label="Statement period"
          >
            {/* Keep the current period selectable even if the list is still loading or omits it. */}
            {period && !periods.some((pp) => pp.period === period) && (
              <option value={period}>{period}</option>
            )}
            {periods.map((pp) => (
              <option key={pp.period} value={pp.period}>
                {pp.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn ghost sm" onClick={() => window.print()}>
          Print / Save as PDF
        </button>
      </div>
    </div>
  );

  if (state === 'loading') {
    return (
      <div className="stmt-root">
        {chrome}
        <div className="stmt-shell">
          <p className="table-empty">Loading…</p>
        </div>
      </div>
    );
  }

  if (state === 'notfound') {
    return (
      <div className="stmt-root">
        {chrome}
        <div className="stmt-shell">
          <p className="table-empty">
            No statement for that quarter. <Link to="/">Back to dashboard</Link>.
          </p>
        </div>
      </div>
    );
  }

  if (state === 'error' || !statement) {
    return (
      <div className="stmt-root">
        {chrome}
        <div className="stmt-shell">
          <p className="form-error" role="alert">
            Could not load this statement. Please try again.
          </p>
        </div>
      </div>
    );
  }

  const { head, portfolio, aggregates, events, quotes, recommendation } = statement;
  const ccy = head.base_currency;
  const generated = formatFullDate(head.generated_at.slice(0, 10));

  return (
    <div className="stmt-root">
      {chrome}

      <div className="stmt-shell">
        <article className="stmt-page">
          {/* ————— head ————— */}
          <header className="stmt-head">
            <span className="wordmark stmt-wordmark">
              <span className="sq" aria-hidden="true"></span>VORHABEN
            </span>
            <div className="stmt-doctitle">Quarterly Statement</div>
            <div className="stmt-period">
              <span className="stmt-period-label">{head.label}</span>
              <span className="stmt-period-range">{headRange(head.from, head.to)}</span>
            </div>
            <div className="stmt-meta num">
              {head.user_email} · Base currency {ccy} · Generated {generated}
            </div>
          </header>

          {/* ————— portfolio ————— */}
          <section className="stmt-portfolio">
            <div className="stmt-seclabel">
              Portfolio · {portfolio.length} {portfolio.length === 1 ? 'project' : 'projects'}
            </div>

            <div className="kpis">
              <div className="kpi">
                <div className="lbl">Total monthly-equivalent</div>
                <div className="val num">{money(aggregates.total_monthly_revenue, ccy)}</div>
                <div className="sub">
                  {aggregates.trend_direction
                    ? `${DIRECTION[aggregates.trend_direction]} vs last quarter`
                    : ''}
                </div>
              </div>
              <div className="kpi">
                <div className="lbl">Monthly net</div>
                <div className="val num">{money(aggregates.total_monthly_net, ccy)}</div>
                <div className="sub num">vs {money(aggregates.prev_monthly_net, ccy)} last quarter</div>
              </div>
              <div className="kpi">
                <div className="lbl">Best rate</div>
                <div className="val stmt-kpi-name">
                  {aggregates.best_by_rate ? aggregates.best_by_rate.name : '—'}
                </div>
                <div className="sub num">
                  {aggregates.best_by_rate ? `${money(aggregates.best_by_rate.value, ccy)}/h` : ''}
                </div>
              </div>
              <div className="kpi">
                <div className="lbl">Heaviest</div>
                <div className="val stmt-kpi-name">
                  {aggregates.heaviest ? aggregates.heaviest.name : '—'}
                </div>
                <div className="sub num">
                  {aggregates.heaviest ? `${formatHours(String(aggregates.heaviest.value))} h` : ''}
                </div>
              </div>
            </div>

            <div className="table-scroll">
              <table className="projects stmt-table">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Status</th>
                    <th className="r">Monthly net</th>
                    <th className="r">Eff. rate</th>
                    <th className="r">Hours</th>
                    <th className="r">Total rev.</th>
                    <th>Mood</th>
                    <th>Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {portfolio.map((p) => (
                    <PortfolioRow key={p.project_id} p={p} ccy={ccy} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* ————— narrative ————— */}
          <section className="stmt-narrative">
            <div className="stmt-seclabel">The quarter</div>
            <p className="stmt-lede">{ledeSentence(aggregates, ccy)}</p>

            {events.ended.length > 0 && (
              <div className="stmt-ended">
                {events.ended.map((e) => (
                  <div className="stmt-ended-item" key={e.project_id}>
                    <div className="stmt-ended-name">{e.name}</div>
                    <div className="stmt-lifespan num">
                      {formatFullDate(e.start_date)} – {formatFullDate(e.end_date)} · {e.lifespan_days}{' '}
                      days · {money(e.lifetime_revenue, ccy)} over{' '}
                      {e.lifetime_hours === null ? '—' : `${formatHours(String(e.lifetime_hours))} h`}
                    </div>
                    {e.ending_note && <p className="stmt-ended-note">{e.ending_note}</p>}
                  </div>
                ))}
              </div>
            )}

            {events.harsh_swings.length > 0 && (
              <p className="stmt-warn">
                Watch the swings: {events.harsh_swings.map((s) => s.name).join(', ')}.
              </p>
            )}

            {events.weeks_closed > 0 && (
              <p className="stmt-weeks">You closed {events.weeks_closed} of 13 weeks this quarter.</p>
            )}

            {quotes.length > 0 && (
              <div className="stmt-quotes">
                {quotes.map((q, i) => (
                  <blockquote className="stmt-quote" key={`${q.project_id}-${i}`}>
                    {q.text}
                    <span className="stmt-quote-cite num">
                      — {q.project_name} · {formatFullDate(q.date)}
                    </span>
                  </blockquote>
                ))}
              </div>
            )}
          </section>

          {/* ————— recommendation (exactly one, set as a pull quote) ————— */}
          {recommendation && (
            <section className="stmt-reco">
              <div className="stmt-reco-eyebrow">For next quarter</div>
              <p className="stmt-reco-sentence">{recommendation.sentence}</p>
            </section>
          )}

          {/* ————— footer ————— */}
          <footer className="stmt-foot num">
            Vorhaben · self-reported figures — not a financial statement · generated {generated} · base
            currency {ccy}
          </footer>
        </article>
      </div>
    </div>
  );
}
