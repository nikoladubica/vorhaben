// RANKINGS — the two best-performer lists, side by side. Their disagreement is the insight, so
// they are NEVER merged into one score or table (BUSINESS_LOGIC §4.1). Left ranks by
// monthly-equivalent revenue; right ranks by effective hourly rate. Ported from the design file's
// `.rank` / `.rank-row` / `.rbar` markup (screen 01), with the top row accented red and the rest
// muted grey — one red thing per panel.

import { Link } from 'react-router-dom';
import type { RankedProject } from '../../api/dashboard';
import { formatMoney } from '../../domain/format';
import { useTooltip } from '../charts/useTooltip';

interface RankingsPanelsProps {
  byMonthlyRevenue: RankedProject[];
  byHourlyRate: RankedProject[];
  baseCurrency: string;
  typeLabel: (typeId: string) => string;
}

export function RankingsPanels({
  byMonthlyRevenue,
  byHourlyRate,
  baseCurrency,
  typeLabel,
}: RankingsPanelsProps) {
  const tip = useTooltip();

  // Bar widths are proportional to the largest value IN THAT LIST (each panel has its own scale).
  // The revenue panel ranks by monthly NET (profit) — which equals revenue for projects without
  // expenses — so the bar/value use monthly_net throughout.
  const maxRevenue = Math.max(
    0,
    ...byMonthlyRevenue.map((p) => p.monthly_net ?? 0),
  );
  const maxRate = Math.max(0, ...byHourlyRate.map((p) => p.effective_hourly_rate ?? 0));

  function revenueRow(project: RankedProject, index: number) {
    const value = project.monthly_net;
    const width = maxRevenue > 0 && value !== null ? (value / maxRevenue) * 100 : 0;
    const display = value === null ? '—' : formatMoney(String(value), baseCurrency);
    // A project absent from the hourly ranking (null rate) gets a hint here so users learn that
    // logging hours unlocks the second, often more revealing, ranking.
    const noHours = project.effective_hourly_rate === null;
    // Expenses (§8): a project with any expenses shows a "net" tag and a revenue − expenses
    // breakdown in the tooltip. Projects without expenses render exactly as before (net === revenue).
    const hasExpenses = project.monthly_expenses !== null;
    const content = (
      <>
        <div>
          {project.name} · <b>{display}</b>
          {hasExpenses ? ' net' : ''}
        </div>
        {hasExpenses ? (
          <div>
            {formatMoney(String(project.monthly_revenue ?? 0), baseCurrency)} revenue −{' '}
            {formatMoney(String(project.monthly_expenses ?? 0), baseCurrency)} expenses
          </div>
        ) : (
          <div>monthly-equivalent · trailing 3 months</div>
        )}
      </>
    );
    return (
      <Link
        key={project.project_id}
        className="rank-row"
        to={`/projects/${project.project_id}`}
        onMouseMove={(e) => tip.showAt(content, e.clientX, e.clientY)}
        onMouseLeave={tip.hide}
        onFocus={(e) => tip.showAtElement(content, e.currentTarget)}
        onBlur={tip.hide}
      >
        <span className="n">
          {project.name}
          <small>{typeLabel(project.type)}</small>
          {hasExpenses && <small className="hint">net /mo</small>}
          {noHours && <small className="hint">no hours logged</small>}
        </span>
        <span className="rbar">
          <i className={index === 0 ? '' : 'mute'} style={{ width: `${width}%` }} />
        </span>
        <span className="v num">{display}</span>
      </Link>
    );
  }

  function rateRow(project: RankedProject, index: number) {
    const value = project.effective_hourly_rate ?? 0;
    const width = maxRate > 0 ? (value / maxRate) * 100 : 0;
    const display = `${formatMoney(String(value), baseCurrency)}/h`;
    const content = (
      <>
        <div>
          {project.name} · <b>{display}</b>
        </div>
        <div>effective rate · trailing 3 months</div>
      </>
    );
    return (
      <Link
        key={project.project_id}
        className="rank-row"
        to={`/projects/${project.project_id}`}
        onMouseMove={(e) => tip.showAt(content, e.clientX, e.clientY)}
        onMouseLeave={tip.hide}
        onFocus={(e) => tip.showAtElement(content, e.currentTarget)}
        onBlur={tip.hide}
      >
        <span className="n">
          {project.name}
          <small>{typeLabel(project.type)}</small>
        </span>
        <span className="rbar">
          <i className={index === 0 ? '' : 'mute'} style={{ width: `${width}%` }} />
        </span>
        <span className="v num">{display}</span>
      </Link>
    );
  }

  return (
    <div className="rank-cols">
      <div className="panel">
        <div className="panel-h">
          <span className="t">By monthly income</span>
          <span className="s">trailing 3 months</span>
        </div>
        <div className="panel-b">
          {byMonthlyRevenue.length === 0 ? (
            <p className="rank-empty">No ranked projects yet.</p>
          ) : (
            <div className="rank">{byMonthlyRevenue.map(revenueRow)}</div>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-h">
          <span className="t">By hourly rate</span>
          <span className="s">effective · active projects</span>
        </div>
        <div className="panel-b">
          {byHourlyRate.length === 0 ? (
            <p className="rank-empty">Log hours to rank projects by effective rate.</p>
          ) : (
            <div className="rank">{byHourlyRate.map(rateRow)}</div>
          )}
        </div>
      </div>
      {tip.element}
    </div>
  );
}
