// KPI summary row — the four headline figures at the top of the dashboard (design screen 01,
// `.kpis`). Every number is derived from the dashboard read model already on screen; nothing new is
// fetched and nothing is fabricated. Headline figures are rounded to whole units to match the
// design ("CHF 7'120", "CHF 41/h") — the precise values live in the panels below.

import type { Dashboard } from '../../api/dashboard';
import { formatMoney } from '../../domain/format';

interface KpiRowProps {
  dashboard: Dashboard;
  baseCurrency: string;
}

// 'YYYY-MM' → 'May' (short month, for the "vs May" delta caption).
function shortMonth(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  if (!y || !m) return monthKey;
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short' });
}

export function KpiRow({ dashboard, baseCurrency }: KpiRowProps) {
  const { rankings, trend, timeline } = dashboard;
  const revenueRanked = rankings.by_monthly_revenue;

  // 1. Monthly-equivalent income — portfolio sum of monthly net (net === revenue when a project has
  //    no expenses). Month-over-month delta comes from the trend totals (actual logged income) and
  //    is shown only when the prior month has a positive base to compare against.
  const monthlyIncome = revenueRanked.reduce(
    (sum, p) => sum + (p.monthly_net ?? p.monthly_revenue ?? 0),
    0,
  );
  const totals = trend.months.map((_, i) =>
    trend.series.reduce((s, series) => s + (series.values[i] ?? 0), 0),
  );
  const lastTotal = totals[totals.length - 1] ?? 0;
  const prevTotal = totals[totals.length - 2] ?? 0;
  const deltaPct = prevTotal > 0 ? ((lastTotal - prevTotal) / prevTotal) * 100 : null;
  const prevMonthLabel =
    trend.months.length >= 2 ? shortMonth(trend.months[trend.months.length - 2]) : null;

  // 2. Effective hourly rate — the portfolio's blended rate: total windowed net over total windowed
  //    hours, i.e. the hours-weighted average of the per-project rates (each rate is net ÷ hours, so
  //    rate × hours recovers that project's net). This matches the server's own definition and needs
  //    no window-length assumption. It is null exactly when no project logged hours in the window —
  //    the same reason a project's own effective_hourly_rate is null (see normalization.ts).
  let weightedNet = 0;
  let windowHours = 0;
  for (const p of revenueRanked) {
    if (p.hours_in_window > 0 && p.effective_hourly_rate !== null) {
      weightedNet += p.effective_hourly_rate * p.hours_in_window;
      windowHours += p.hours_in_window;
    }
  }
  const blendedRate = windowHours > 0 ? weightedNet / windowHours : null;

  // 3. Active projects — active/paused come from the rankings (which exclude ended/idea); the
  //    ended-this-year count comes from the timeline, which still carries ended projects.
  const activeCount = revenueRanked.filter((p) => p.status === 'active').length;
  const pausedCount = revenueRanked.filter((p) => p.status === 'paused').length;
  const thisYear = new Date().getFullYear();
  const endedThisYear = timeline.filter(
    (p) => p.end_date && new Date(p.end_date).getFullYear() === thisYear,
  ).length;
  const activeSub: string[] = [];
  if (pausedCount > 0) activeSub.push(`${pausedCount} paused`);
  if (endedThisYear > 0) activeSub.push(`${endedThisYear} ended this year`);

  // 4. Best performer — top of the effective-hourly-rate ranking.
  const best = rankings.by_hourly_rate[0] ?? null;

  return (
    <div className="kpis">
      <div className="kpi">
        <div className="lbl">Monthly-equivalent income</div>
        <div className="val num">
          {formatMoney(String(Math.round(monthlyIncome)), baseCurrency)}
        </div>
        <div className="sub">
          {deltaPct !== null && prevMonthLabel ? (
            <>
              <span className={deltaPct >= 0 ? 'delta-up' : 'delta-down'}>
                {deltaPct >= 0 ? '▲' : '▼'} {Math.abs(deltaPct).toFixed(1)}%
              </span>
              vs {prevMonthLabel}
            </>
          ) : (
            'monthly-equivalent'
          )}
        </div>
      </div>

      <div className="kpi">
        <div className="lbl">Effective hourly rate</div>
        <div className="val num">
          {blendedRate !== null
            ? `${formatMoney(String(Math.round(blendedRate)), baseCurrency)}/h`
            : '—'}
        </div>
        <div className="sub num">
          {windowHours > 0 ? `across ${Math.round(windowHours)} h logged` : 'no hours logged'}
        </div>
      </div>

      <div className="kpi">
        <div className="lbl">Active projects</div>
        <div className="val num">{activeCount}</div>
        <div className="sub">{activeSub.length > 0 ? activeSub.join(' · ') : 'all active'}</div>
      </div>

      <div className="kpi">
        <div className="lbl">Best performer</div>
        {best ? (
          <>
            <div className="val" style={{ fontSize: 20, paddingTop: 4 }}>
              {best.name}
            </div>
            <div className="sub num">
              {best.effective_hourly_rate !== null
                ? `${formatMoney(String(Math.round(best.effective_hourly_rate)), baseCurrency)}/h effective`
                : 'no rate yet'}
            </div>
          </>
        ) : (
          <div className="val">—</div>
        )}
      </div>
    </div>
  );
}
