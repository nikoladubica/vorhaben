// TREND — a single-series aggregate column chart (design file screen 01, `<svg id="trend">`).
//
// Design-system decision (overrides the ticket's "stacked per-project" wording): the Swiss token
// palette is monochrome ink + one red accent, with NO categorical colours, so a stacked
// per-project chart is impossible to render legibly within it. Instead we draw ONE grey column
// per month for the TOTAL monthly-equivalent income (the sum of every series' value at that month
// index), with the current (last) month accented red. The per-project split for a month is
// surfaced in the hover/focus tooltip — never as coloured segments.

import type { Dashboard } from '../../api/dashboard';
import { formatMoney } from '../../domain/format';
import { columnPath, monthShortLabel, niceScale } from '../charts/scale';
import { useTooltip } from '../charts/useTooltip';

interface TrendChartProps {
  trend: Dashboard['trend'];
  baseCurrency: string;
}

// Viewport-independent drawing space; the SVG scales to its container width.
const W = 640;
const H = 220;
const PAD_L = 48; // room for grouped base-currency y ticks (e.g. 6'000)
const PAD_R = 10;
const PAD_T = 18;
const PAD_B = 26;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;
const MAX_BAR_W = 24;

export function TrendChart({ trend, baseCurrency }: TrendChartProps) {
  const tip = useTooltip();
  const { months, series } = trend;

  // Total per month = sum across every project's aligned, zero-filled value at that index.
  const totals = months.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const { yMax, ticks } = niceScale(Math.max(0, ...totals));

  const band = PLOT_W / Math.max(months.length, 1);
  const barW = Math.min(MAX_BAR_W, band * 0.55);

  // The per-month tooltip body: the split of that month across projects with a non-zero value.
  function monthTooltip(index: number) {
    const label = monthShortLabel(months[index] ?? '');
    const split = series
      .map((s) => ({ name: s.name, value: s.values[index] ?? 0 }))
      .filter((row) => row.value > 0)
      .sort((a, b) => b.value - a.value);
    return (
      <>
        <div>
          {label} · <b>{formatMoney(String(totals[index] ?? 0), baseCurrency)}</b>
        </div>
        {split.length === 0 ? (
          <div>No income</div>
        ) : (
          split.map((row) => (
            <div key={row.name}>
              {row.name} <b>{formatMoney(String(row.value), baseCurrency)}</b>
            </div>
          ))
        )}
      </>
    );
  }

  // The accessible label mirrors the tooltip so keyboard/AT users get the same numbers.
  function monthAriaLabel(index: number): string {
    const label = monthShortLabel(months[index] ?? '');
    return `${label}: ${formatMoney(String(totals[index] ?? 0), baseCurrency)} monthly-equivalent income`;
  }

  return (
    <figure className="chart" style={{ margin: 0 }}>
      <svg
        className="trend"
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={`Monthly income over ${months.length} months, in ${baseCurrency}`}
      >
        {/* gridlines + y ticks (clean numbers); baseline (v === 0) is the darker hairline */}
        {ticks.map((v) => {
          const y = PAD_T + PLOT_H - (v / yMax) * PLOT_H;
          return (
            <g key={v}>
              <line
                x1={PAD_L}
                y1={y}
                x2={W - PAD_R}
                y2={y}
                className={v === 0 ? 'baseline' : 'grid-line'}
              />
              <text x={PAD_L - 8} y={y + 3.5} textAnchor="end" className="tick">
                {formatMoney(String(v), '')}
              </text>
            </g>
          );
        })}

        {months.map((monthKey, i) => {
          const isCurrent = i === months.length - 1;
          const x = PAD_L + band * i + (band - barW) / 2;
          const h = yMax > 0 ? ((totals[i] ?? 0) / yMax) * PLOT_H : 0;
          const y = PAD_T + PLOT_H - h;
          return (
            <g key={monthKey}>
              {h > 0 && (
                <path d={columnPath(x, y, barW, h)} className={isCurrent ? 'bar cur' : 'bar'} />
              )}
              <text x={x + barW / 2} y={H - 8} textAnchor="middle" className="tick">
                {monthShortLabel(monthKey)}
              </text>
              {isCurrent && (totals[i] ?? 0) > 0 && (
                <text x={x + barW / 2} y={y - 7} textAnchor="middle" className="dlabel">
                  {formatMoney(String(totals[i] ?? 0), '')}
                </text>
              )}
              {/* full-height, keyboard-focusable hit target for hover/focus tooltips */}
              <rect
                x={PAD_L + band * i}
                y={PAD_T}
                width={band}
                height={PLOT_H}
                fill="transparent"
                tabIndex={0}
                role="img"
                aria-label={monthAriaLabel(i)}
                onMouseMove={(e) => tip.showAt(monthTooltip(i), e.clientX, e.clientY)}
                onMouseLeave={tip.hide}
                onFocus={(e) => tip.showAtElement(monthTooltip(i), e.currentTarget)}
                onBlur={tip.hide}
              />
            </g>
          );
        })}
      </svg>
      {tip.element}
    </figure>
  );
}
