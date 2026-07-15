// SCENARIO PANEL — the "What if" thought experiment at the bottom of the dashboard (design screen
// 12). Move N weekly hours from one project to another and preview the monthly-equivalent
// difference at their already-computed effective hourly rates. Nothing is persisted — no API call,
// no localStorage, pure derived state; the stored hours are never touched (BUSINESS_LOGIC §8).
//
// The maths reuses the normalization identity: a project's monthly-equivalent revenue is its
// weekly hours × (52/12) weeks per month × effective hourly rate. Shifting `h` weekly hours from
// the source (rateFrom) to the target (rateTo) changes the portfolio total by
//   h × (52/12) × (rateTo − rateFrom).

import { useMemo, useState } from 'react';
import type { RankedProject } from '../../api/dashboard';
import { formatMoney } from '../../domain/format';

// Weeks per month — the same 52/12 the server uses to turn weekly hours into a monthly figure.
const WEEKS_PER_MONTH = 52 / 12;

interface ScenarioPanelProps {
  // The dashboard rankings, already fetched by the page. The full portfolio (nulls kept) so the
  // current total sums every project; only those with an effective rate are shift-selectable.
  rankings: RankedProject[];
  baseCurrency: string;
}

export function ScenarioPanel({ rankings, baseCurrency }: ScenarioPanelProps) {
  // Only projects with a known effective rate can take part in the shift; ordered low → high so the
  // default "from" (lowest rate) and "to" (highest rate) are the ends of the list.
  const rated = useMemo(
    () =>
      rankings
        .filter(
          (p): p is RankedProject & { effective_hourly_rate: number } =>
            p.effective_hourly_rate !== null,
        )
        .sort((a, b) => a.effective_hourly_rate - b.effective_hourly_rate),
    [rankings],
  );

  // The current portfolio monthly-equivalent — sum of each project's net (or revenue when no
  // expenses). Independent of the rated subset so the baseline reflects the whole portfolio.
  const currentTotal = useMemo(
    () => rankings.reduce((sum, p) => sum + (p.monthly_net ?? p.monthly_revenue ?? 0), 0),
    [rankings],
  );

  const lowestId = rated[0]?.project_id ?? null;
  const highestId = rated[rated.length - 1]?.project_id ?? null;

  const [fromId, setFromId] = useState<number | null>(lowestId);
  const [toId, setToId] = useState<number | null>(highestId);
  const [hours, setHours] = useState(5);

  // Fewer than two rated projects → there is nothing to shift between. Show a quiet empty state.
  if (rated.length < 2) {
    return (
      <section className="panel" aria-labelledby="scn-title">
        <div className="scn-empty">
          <span className="eyebrow">What if</span>
          <p id="scn-title" style={{ marginTop: 8 }}>
            Log hours on at least two projects to explore shifting time toward your best rate.
          </p>
        </div>
      </section>
    );
  }

  const from = rated.find((p) => p.project_id === fromId) ?? rated[0];
  const to = rated.find((p) => p.project_id === toId) ?? rated[rated.length - 1];

  const monthlyDelta =
    hours * WEEKS_PER_MONTH * (to.effective_hourly_rate - from.effective_hourly_rate);
  const scenarioTotal = currentTotal + monthlyDelta;

  // Round to whole francs for display, matching the design's clean CHF figures.
  const deltaSign = monthlyDelta > 0 ? '+ ' : monthlyDelta < 0 ? '− ' : '';
  const deltaBody = formatMoney(String(Math.round(Math.abs(monthlyDelta))), baseCurrency);

  const rate = (p: RankedProject & { effective_hourly_rate: number }) =>
    `${p.name} · ${Math.round(p.effective_hourly_rate)}/h`;

  return (
    <section className="panel scn" aria-labelledby="scn-title">
      <div className="scn-left">
        <span className="eyebrow">What if</span>
        <h4 id="scn-title" style={{ marginTop: 8 }}>
          Shift hours toward your best rate.
        </h4>
        <p className="desc">
          Move weekly hours from one project to another and see the monthly difference at current
          effective rates. Nothing is saved — it’s a thought experiment.
        </p>

        <div className="scn-move num">
          <span>Move</span>
          <b className="hrs">{hours} h/wk</b>
          <span>from</span>
          <select
            className="scn-sel"
            aria-label="Shift hours from project"
            value={from.project_id}
            onChange={(e) => setFromId(Number(e.target.value))}
          >
            {rated.map((p) => (
              <option key={p.project_id} value={p.project_id}>
                {rate(p)}
              </option>
            ))}
          </select>
          <span>to</span>
          <select
            className="scn-sel"
            aria-label="Shift hours to project"
            value={to.project_id}
            onChange={(e) => setToId(Number(e.target.value))}
          >
            {rated.map((p) => (
              <option key={p.project_id} value={p.project_id}>
                {rate(p)}
              </option>
            ))}
          </select>
        </div>

        <input
          type="range"
          className="sld"
          min={0}
          max={10}
          step={1}
          value={hours}
          onChange={(e) => setHours(Number(e.target.value))}
          aria-label="Hours per week to shift"
        />
        <div className="sld-scale">
          <span>0 h</span>
          <span>5 h</span>
          <span>10 h</span>
        </div>
      </div>

      <div className="scn-right">
        <div className="scn-out num">
          <div className="row">
            <span>Current monthly-equivalent</span>
            <b>{formatMoney(String(Math.round(currentTotal)), baseCurrency)}</b>
          </div>
          <div className="row">
            <span>Scenario monthly-equivalent</span>
            <b>{formatMoney(String(Math.round(scenarioTotal)), baseCurrency)}</b>
          </div>
          <div className="row big">
            <span>Difference</span>
            <b className={monthlyDelta > 0 ? undefined : 'flat'}>
              {deltaSign}
              {deltaBody}
            </b>
          </div>
        </div>
        <p className="scn-fine">
          Assumes {to.name} can absorb the hours at {Math.round(to.effective_hourly_rate)}/h and{' '}
          {from.name} scales with time — treat it as direction, not a forecast.
        </p>
      </div>
    </section>
  );
}
