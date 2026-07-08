// TIMELINE — a Gantt-style strip, one row per project, over the selected month window (design
// file's projects/timeline screen, `.tl` / `#tlRows`). Bars are clamped to the window; an
// open-ended project (null end_date) runs to the right edge with a square end. Styling by status:
// the best-effective-rate project (rankings.by_hourly_rate[0]) is red, ended projects are hairline
// grey, everything else is muted grey — one red thing per view.

import { Link } from 'react-router-dom';
import type { TimelineProject } from '../../api/dashboard';
import { formatMonthYear } from '../../domain/format';
import { monthShortLabel } from '../charts/scale';
import { useTooltip } from '../charts/useTooltip';

interface TimelineProps {
  timeline: TimelineProject[];
  months: string[]; // the window, oldest first ('YYYY-MM')
  bestRateProjectId: number | null;
}

// The timeline payload carries status (not type — type is absent for ended projects), so the row
// caption is the lifecycle status, title-cased.
function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

// Absolute month index of a 'YYYY-MM' key (UTC-safe integer arithmetic, no Date drift).
function monthAbs(monthKey: string): number {
  return Number(monthKey.slice(0, 4)) * 12 + (Number(monthKey.slice(5, 7)) - 1);
}

// Fractional absolute-month position of a 'YYYY-MM-DD' date (day mapped into its month's span).
function dateAbs(date: string): number {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return y * 12 + (m - 1) + (d - 1) / daysInMonth;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function Timeline({ timeline, months, bestRateProjectId }: TimelineProps) {
  const tip = useTooltip();
  if (timeline.length === 0 || months.length === 0) return null;

  const columns = months.length;
  const windowStart = monthAbs(months[0]); // left edge = start of the first month
  const trackStyle = {
    backgroundImage: `repeating-linear-gradient(to right, var(--grid) 0 1px, transparent 1px calc(100% / ${columns}))`,
  };

  return (
    <div className="tl">
      <div className="tl-months">
        <span />
        <div
          className="tl-scale num"
          style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
          aria-hidden="true"
        >
          {months.map((monthKey) => (
            <span key={monthKey}>{monthShortLabel(monthKey).charAt(0)}</span>
          ))}
        </div>
      </div>

      {timeline.map((project) => {
        const open = project.end_date === null;
        const startPos = clamp(dateAbs(project.start_date) - windowStart, 0, columns);
        const endPos = open
          ? columns
          : clamp(dateAbs(project.end_date as string) - windowStart, 0, columns);
        const left = (startPos / columns) * 100;
        const width = (Math.max(0, endPos - startPos) / columns) * 100;

        const barClass =
          project.project_id === bestRateProjectId
            ? 'hot'
            : project.status === 'ended'
              ? 'ended'
              : '';

        const range = `${formatMonthYear(project.start_date)} — ${
          open ? 'ongoing' : formatMonthYear(project.end_date as string)
        }`;
        const content = (
          <>
            <div>
              {project.name} · <b>{open ? 'ongoing' : 'ended'}</b>
            </div>
            <div>{range}</div>
          </>
        );

        return (
          <Link
            key={project.project_id}
            className="tl-row"
            to={`/projects/${project.project_id}`}
            aria-label={`${project.name}, ${statusLabel(project.status)}, ${range}`}
            onMouseMove={(e) => tip.showAt(content, e.clientX, e.clientY)}
            onMouseLeave={tip.hide}
            onFocus={(e) => tip.showAtElement(content, e.currentTarget)}
            onBlur={tip.hide}
          >
            <span className="tl-n">
              {project.name}
              <small>{statusLabel(project.status)}</small>
            </span>
            <span className="tl-track" style={trackStyle}>
              <span
                className={`tl-bar ${barClass}${open ? ' open' : ''}`}
                style={{ left: `${left}%`, width: `${width}%` }}
              />
            </span>
          </Link>
        );
      })}
      {tip.element}
    </div>
  );
}
