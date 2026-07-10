// RANKING PANEL — one best-performer list in a hairline panel (design screen 01, `.rank` /
// `.rank-row` / `.rbar`). Used twice on the dashboard: the effective-hourly-rate ranking beside the
// income chart, and the monthly-income ranking below. The two are never merged into one score —
// their disagreement is the insight (BUSINESS_LOGIC §4.1). Bar widths are proportional to the
// largest value in THIS list; the top row is accented red, the rest muted grey (one red per panel).

import { Link } from 'react-router-dom';
import type { RankedProject } from '../../api/dashboard';
import { formatMoney } from '../../domain/format';
import { useTooltip } from '../charts/useTooltip';

interface RankingPanelProps {
  title: string;
  subtitle: string;
  // 'rate' ranks by effective hourly rate; 'revenue' by monthly net (profit, === revenue when a
  // project has no expenses).
  mode: 'rate' | 'revenue';
  projects: RankedProject[];
  baseCurrency: string;
  typeLabel: (typeId: string) => string;
  emptyText: string;
}

export function RankingPanel({
  title,
  subtitle,
  mode,
  projects,
  baseCurrency,
  typeLabel,
  emptyText,
}: RankingPanelProps) {
  const tip = useTooltip();

  const valueOf = (p: RankedProject) => (mode === 'rate' ? p.effective_hourly_rate : p.monthly_net);
  const max = Math.max(0, ...projects.map((p) => valueOf(p) ?? 0));

  function row(project: RankedProject, index: number) {
    const value = valueOf(project);
    const width = max > 0 && value !== null ? (value / max) * 100 : 0;
    const display =
      value === null
        ? '—'
        : mode === 'rate'
          ? `${formatMoney(String(value), baseCurrency)}/h`
          : formatMoney(String(value), baseCurrency);

    // Expenses (§8): a project with expenses shows a "net" tag and a revenue − expenses breakdown.
    const hasExpenses = mode === 'revenue' && project.monthly_expenses !== null;
    // In the revenue list, a project with no logged hours gets a hint that logging hours unlocks
    // the (often more revealing) rate ranking.
    const noHours = mode === 'revenue' && project.effective_hourly_rate === null;

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
          <div>{mode === 'rate' ? 'effective rate' : 'monthly-equivalent'} · trailing 3 months</div>
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

  return (
    <div className="panel">
      <div className="panel-h">
        <span className="t">{title}</span>
        <span className="s">{subtitle}</span>
      </div>
      <div className="panel-b">
        {projects.length === 0 ? (
          <p className="rank-empty">{emptyText}</p>
        ) : (
          <div className="rank">{projects.map(row)}</div>
        )}
      </div>
      {tip.element}
    </div>
  );
}
