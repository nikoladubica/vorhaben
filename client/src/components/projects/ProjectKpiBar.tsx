// The project-detail overview bar (design screen 04, `.kpis`). Renders the headline normalized
// figures for one project and lets the user choose which ones to show. Four are on by default
// — monthly-equivalent income, effective rate, hours this month, earned to date — and a filter
// popover below the bar adds the money-out counterparts (expenses, net, spent / difference to
// date). Every figure comes straight from GET /api/projects/:id/metrics; nothing is fabricated.
// The choice persists per browser in localStorage (a display preference, not per-project state).

import { useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ProjectMetrics } from '../../types';
import { formatMoney, formatMonthYear } from '../../domain/format';
import { useDismiss } from '../canvas/useDismiss';

type KpiKey = 'income' | 'rate' | 'hours' | 'earned' | 'expenses' | 'net' | 'spent' | 'difference';

interface KpiDef {
  key: KpiKey;
  label: string;
  // Whether it is part of the default four (drives the fallback selection + popover grouping).
  byDefault: boolean;
  render: (m: ProjectMetrics, ctx: KpiContext) => { value: ReactNode; sub: ReactNode };
}

interface KpiContext {
  currency: string;
  startLabel: string; // e.g. "Sep 2025" — for the "since …" captions
}

const STORAGE_KEY = 'vorhaben.pd.kpis';

// Whole-unit money, matching the design ("CHF 1'850"); an em dash when the figure is null.
function money(value: number | null, currency: string): string {
  return value === null ? '—' : formatMoney(String(Math.round(value)), currency);
}

// The full catalogue, in canonical display order. Selection is a Set; the bar always renders in
// this order regardless of the order the user toggled things on, so the layout stays stable.
const CATALOG: KpiDef[] = [
  {
    key: 'income',
    label: 'Monthly-equivalent income',
    byDefault: true,
    render: (m, ctx) => ({
      value: money(m.monthly_revenue, ctx.currency),
      sub: 'monthly-equivalent',
    }),
  },
  {
    key: 'rate',
    label: 'Effective rate',
    byDefault: true,
    render: (m, ctx) => ({
      value:
        m.effective_hourly_rate === null
          ? '—'
          : `${money(m.effective_hourly_rate, ctx.currency)}/h`,
      sub: 'net ÷ hours, trailing 3 months',
    }),
  },
  {
    key: 'hours',
    label: 'Hours this month',
    byDefault: true,
    render: (m) => {
      // hours_in_window is the total across the (≤3-month) window; express it per month so the
      // headline reads as a typical month, matching the design's "30 h · ≈ 7 h/week".
      const perMonth = m.window_months > 0 ? m.hours_in_window / m.window_months : 0;
      return {
        value: `${Math.round(perMonth)} h`,
        sub: perMonth > 0 ? `≈ ${Math.round(perMonth / 4.33)} h/week` : 'no hours logged',
      };
    },
  },
  {
    key: 'earned',
    label: 'Earned to date',
    byDefault: true,
    render: (m, ctx) => ({
      value: money(m.total_revenue, ctx.currency),
      sub: `since ${ctx.startLabel}`,
    }),
  },
  {
    key: 'expenses',
    label: 'Monthly-equivalent expenses',
    byDefault: false,
    render: (m, ctx) => ({
      value: money(m.monthly_expenses, ctx.currency),
      sub: 'monthly-equivalent',
    }),
  },
  {
    key: 'net',
    label: 'Net, monthly-equiv.',
    byDefault: false,
    render: (m, ctx) => ({
      value: money(m.monthly_net, ctx.currency),
      sub: 'income − expenses',
    }),
  },
  {
    key: 'spent',
    label: 'Spent to date',
    byDefault: false,
    render: (m, ctx) => ({
      value: money(m.total_expenses, ctx.currency),
      sub: `since ${ctx.startLabel}`,
    }),
  },
  {
    key: 'difference',
    label: 'Difference to date',
    byDefault: false,
    render: (m, ctx) => {
      // All-time earned minus all-time spent. Null only when neither side has any entries.
      const value =
        m.total_revenue === null && m.total_expenses === null
          ? null
          : (m.total_revenue ?? 0) - (m.total_expenses ?? 0);
      return { value: money(value, ctx.currency), sub: 'earned − spent' };
    },
  },
];

const VALID_KEYS = new Set(CATALOG.map((k) => k.key));
// The four figures shown until the user customises — the single source of truth is `byDefault`.
const DEFAULT_KEYS = CATALOG.filter((k) => k.byDefault).map((k) => k.key);

// Read the saved selection, falling back to the default four. Unknown keys (from an older or
// newer build) are dropped; an empty result also falls back so the bar is never blank.
function loadSelection(): Set<KpiKey> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const keys = parsed.filter((k): k is KpiKey => VALID_KEYS.has(k as KpiKey));
        if (keys.length > 0) return new Set(keys);
      }
    }
  } catch {
    // fall through to the default
  }
  return new Set(DEFAULT_KEYS);
}

export function ProjectKpiBar({
  metrics,
  currency,
  startDate,
}: {
  metrics: ProjectMetrics;
  currency: string;
  startDate: string;
}) {
  const [selected, setSelected] = useState<Set<KpiKey>>(loadSelection);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useDismiss(open, wrapRef, () => setOpen(false));

  const ctx: KpiContext = useMemo(
    () => ({ currency: metrics.base_currency ?? currency, startLabel: formatMonthYear(startDate) }),
    [metrics.base_currency, currency, startDate],
  );

  function toggle(key: KpiKey) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        // Keep at least one figure on the bar — never let it empty out.
        if (next.size > 1) next.delete(key);
      } else {
        next.add(key);
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  const shown = CATALOG.filter((k) => selected.has(k.key));

  return (
    <div className="pd-kpis">
      <div className="kpis">
        {shown.map((def) => {
          const { value, sub } = def.render(metrics, ctx);
          return (
            <div className="kpi" key={def.key}>
              <div className="lbl">{def.label}</div>
              <div className="val num">{value}</div>
              <div className="sub num">{sub}</div>
            </div>
          );
        })}
      </div>

      <div className="kpi-filter" ref={wrapRef}>
        <button
          type="button"
          className="btn ghost sm"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          Metrics — {selected.size} shown
        </button>

        {open && (
          <div className="kpi-menu" role="menu" aria-label="Choose metrics">
            <div className="mh">Show on this project</div>
            {CATALOG.map((def) => {
              const on = selected.has(def.key);
              const last = on && selected.size === 1;
              return (
                <button
                  key={def.key}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  className={on ? 'on' : ''}
                  disabled={last}
                  onClick={() => toggle(def.key)}
                >
                  <span className="box" aria-hidden="true">
                    {on ? '✓' : ''}
                  </span>
                  {def.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
