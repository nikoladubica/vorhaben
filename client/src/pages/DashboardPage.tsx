// Dashboard — the home route, answering "where is my time best spent?" through the five §4.1
// views: the two best-performer rankings (side by side, because their disagreement is the
// insight), the focus callout, the single-series income trend, the timeline, and the
// composition-by-type. Charts are hand-rolled SVG in the Swiss token palette (no chart library).
//
// Data loads in two independent requests: the dashboard (bound to a 3/6/12-month window kept in
// the URL) and the suggestions (optional garnish — a failure there shows nothing and never blocks
// the rest). Project-type labels load separately for display, falling back to the raw id.

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Dashboard, Suggestion } from '../api/dashboard';
import { getDashboard, getSuggestions } from '../api/dashboard';
import { listProjectTypes } from '../api/projects';
import type { ProjectType } from '../types';
import { KpiRow } from '../components/dashboard/KpiRow';
import { RankingPanel } from '../components/dashboard/RankingPanel';
import { FocusCallout } from '../components/dashboard/FocusCallout';
import { TrendChart } from '../components/dashboard/TrendChart';
import { CompositionBar } from '../components/dashboard/CompositionBar';
import { Timeline } from '../components/dashboard/Timeline';
import { MissingRatesNotice } from '../components/dashboard/MissingRatesNotice';
import { MoodNudge } from '../components/mood/MoodNudge';

// The trend/timeline/composition window options (months). The server clamps 1–36; the UI offers
// the three the design calls for and defaults to 6.
const WINDOW_OPTIONS = [3, 6, 12] as const;
const DEFAULT_MONTHS = 6;

function parseMonths(raw: string | null): number {
  const value = Number(raw);
  return (WINDOW_OPTIONS as readonly number[]).includes(value) ? value : DEFAULT_MONTHS;
}

export function DashboardPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const months = parseMonths(searchParams.get('months'));

  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Suggestions and type labels load independently — neither can break the dashboard.
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [types, setTypes] = useState<ProjectType[]>([]);

  // Re-fetch the dashboard whenever the window changes. Keep the previous payload on screen while
  // refetching so switching windows doesn't blank the page.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getDashboard(months)
      .then((data) => {
        if (!cancelled) setDashboard(data);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load your dashboard. Please try again.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [months]);

  useEffect(() => {
    // Optional garnish: on failure we simply show no callout.
    getSuggestions()
      .then((res) => setSuggestions(res.suggestions))
      .catch(() => setSuggestions([]));
  }, []);

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

  // project_id → name, from every view that carries one, so the callout can linkify names.
  const nameById = useMemo(() => {
    const map = new Map<number, string>();
    if (!dashboard) return map;
    for (const p of dashboard.rankings.by_monthly_revenue) map.set(p.project_id, p.name);
    for (const p of dashboard.rankings.by_hourly_rate) map.set(p.project_id, p.name);
    for (const p of dashboard.timeline) map.set(p.project_id, p.name);
    for (const s of dashboard.trend.series) map.set(s.project_id, s.name);
    return map;
  }, [dashboard]);

  const typeLabel = (typeId: string) => typeLabels.get(typeId) ?? typeId;

  function selectMonths(value: number) {
    const next = new URLSearchParams(searchParams);
    next.set('months', String(value));
    setSearchParams(next, { replace: true });
  }

  const header = (
    <div className="dash-head">
      <h3>Overview</h3>
      <div className="dash-controls">
        {dashboard && (
          <span className="period num">
            {new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })} · base
            currency {dashboard.base_currency}
          </span>
        )}
        <div className="seg" role="radiogroup" aria-label="Trend window in months">
          {WINDOW_OPTIONS.map((option) => (
            <div className="sopt" key={option}>
              <input
                type="radio"
                id={`window-${option}`}
                name="window"
                checked={months === option}
                onChange={() => selectMonths(option)}
              />
              <label htmlFor={`window-${option}`}>{option}m</label>
            </div>
          ))}
        </div>
      </div>
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

  if (!dashboard) {
    return (
      <div>
        {header}
        <p className="table-empty">Loading…</p>
      </div>
    );
  }

  const { rankings, trend, composition, timeline, warnings, base_currency } = dashboard;
  const isEmpty =
    rankings.by_monthly_revenue.length === 0 &&
    rankings.by_hourly_rate.length === 0 &&
    timeline.length === 0;

  if (isEmpty) {
    return (
      <div>
        {header}
        <MoodNudge />
        <div className="panel">
          <div className="table-empty">
            <p>
              Nothing to show yet. Add a project and log some income to see where your time pays off
              best.
            </p>
            <Link className="btn primary sm" to="/projects/new">
              Create your first project
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const bestRateProjectId = rankings.by_hourly_rate[0]?.project_id ?? null;

  return (
    <div className={loading ? 'dash-loading' : undefined}>
      {header}

      <MoodNudge />

      <MissingRatesNotice currencies={warnings.missing_rates} />

      <KpiRow dashboard={dashboard} baseCurrency={base_currency} />

      {/* Income chart (2fr) beside the effective-hourly-rate ranking (1fr), per design screen 01. */}
      <div className="cols">
        <div className="panel">
          <div className="panel-h">
            <span className="t">Income, last {months} months</span>
            <span className="s num">monthly-equivalent · {base_currency}</span>
          </div>
          <div className="panel-b">
            <TrendChart trend={trend} baseCurrency={base_currency} />
          </div>
        </div>

        <RankingPanel
          mode="rate"
          title="Effective hourly rate"
          subtitle="active projects"
          projects={rankings.by_hourly_rate}
          baseCurrency={base_currency}
          typeLabel={typeLabel}
          emptyText="Log hours to rank projects by effective rate."
        />
      </div>

      {/* The other lens on the same projects — never merged with the rate ranking above. */}
      <div className="rank-solo">
        <RankingPanel
          mode="revenue"
          title="By monthly income"
          subtitle="trailing 3 months"
          projects={rankings.by_monthly_revenue}
          baseCurrency={base_currency}
          typeLabel={typeLabel}
          emptyText="No ranked projects yet."
        />
      </div>

      <FocusCallout suggestions={suggestions} nameById={nameById} />

      <div className="cols">
        <div className="panel">
          <div className="panel-h">
            <span className="t">Timeline</span>
            <span className="s">red = best effective rate</span>
          </div>
          <div className="panel-b tl-panel">
            <Timeline
              timeline={timeline}
              months={trend.months}
              bestRateProjectId={bestRateProjectId}
            />
          </div>
        </div>

        {composition.length > 0 && (
          <div className="panel">
            <div className="panel-h">
              <span className="t">Where income comes from</span>
              <span className="s">share by type</span>
            </div>
            <div className="panel-b">
              <CompositionBar composition={composition} baseCurrency={base_currency} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
