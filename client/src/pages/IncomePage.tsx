// Income — the portfolio-wide monthly view (design screen 11). A left panel lists every income
// entry across all projects for a chosen calendar month; a right panel shows where that month's
// income came from as proportional `.rank` bars, with a concentration callout when one source
// dominates. The month is URL-bound via ?from=&to= for shareability and stepped with prev/next.
//
// Every money figure in the aggregate (panel header total, per-project shares) is converted to the
// user's base currency SERVER-SIDE; the table's Amount column shows the original amount as entered.

import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { IncomeMonth } from '../api/income';
import { getIncome } from '../api/income';
import { formatMoney, formatDayMonth } from '../domain/format';

// Parse the ?from= param (a month's first day) to a { year, month0 } pair; fall back to the current
// UTC month when it is missing or malformed.
function parseMonth(fromParam: string | null): { year: number; month0: number } {
  const match = fromParam ? /^(\d{4})-(\d{2})-\d{2}$/.exec(fromParam) : null;
  if (match) {
    const year = Number(match[1]);
    const month0 = Number(match[2]) - 1;
    if (Number.isInteger(year) && month0 >= 0 && month0 <= 11) return { year, month0 };
  }
  const now = new Date();
  return { year: now.getUTCFullYear(), month0: now.getUTCMonth() };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// Inclusive first/last calendar day of the given UTC month, as 'YYYY-MM-DD' strings — matches the
// server's default range.
function monthRange(year: number, month0: number): { from: string; to: string } {
  const lastDay = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  return {
    from: `${year}-${pad2(month0 + 1)}-01`,
    to: `${year}-${pad2(month0 + 1)}-${pad2(lastDay)}`,
  };
}

// "June 2026" — full month for the stepper and the entries panel header (matches design 11).
function monthLabel(year: number, month0: number): string {
  return new Date(Date.UTC(year, month0, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// "June" — bare month name for the "Where June came from" header and the concentration note.
function monthName(year: number, month0: number): string {
  return new Date(Date.UTC(year, month0, 1)).toLocaleDateString('en-US', {
    month: 'long',
    timeZone: 'UTC',
  });
}

// Show a concentration callout only when one source is a meaningful majority of the month.
const CONCENTRATION_THRESHOLD = 0.5;

export function IncomePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { year, month0 } = parseMonth(searchParams.get('from'));
  // Canonical range for THIS month, regardless of how (or whether) the URL params were formed.
  const { from, to } = monthRange(year, month0);

  const [data, setData] = useState<IncomeMonth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Re-fetch whenever the month changes. Keep the previous payload on screen while refetching so
  // stepping months never blanks the page.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getIncome(from, to)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load income for this month. Please try again.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [from, to]);

  // Step the selected month by ±1 and rewrite the URL (replace, so back doesn't walk every month).
  function step(delta: number) {
    const shifted = new Date(Date.UTC(year, month0 + delta, 1));
    const range = monthRange(shifted.getUTCFullYear(), shifted.getUTCMonth());
    const next = new URLSearchParams(searchParams);
    next.set('from', range.from);
    next.set('to', range.to);
    setSearchParams(next, { replace: true });
  }

  const label = monthLabel(year, month0);
  const name = monthName(year, month0);

  const header = (
    <div className="dash-head">
      <h3>Income</h3>
      <div className="pd-actions" style={{ alignItems: 'center' }}>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => step(-1)}
          aria-label="Previous month"
        >
          ‹
        </button>
        <span className="period num" aria-live="polite">
          {label}
        </span>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => step(1)}
          aria-label="Next month"
        >
          ›
        </button>
        <Link className="btn primary sm" to="/projects">
          Log income
        </Link>
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

  if (!data) {
    return (
      <div>
        {header}
        <p className="table-empty">Loading…</p>
      </div>
    );
  }

  const { entries, by_project, total, base_currency } = data;
  const entryCount = entries.length;
  const topShare = by_project[0]?.share ?? 0;
  const maxShare = topShare; // bars are relative to the largest slice
  const concentrationPct = Math.round(topShare * 100);

  return (
    <div className={loading ? 'dash-loading' : undefined}>
      {header}

      <div className="cols">
        <div className="panel">
          <div className="panel-h">
            <span className="t">Entries — {label}</span>
            <span className="s num">
              {entryCount} {entryCount === 1 ? 'entry' : 'entries'} ·{' '}
              {formatMoney(total, base_currency)}
            </span>
          </div>
          <div className="panel-b table-scroll" style={{ paddingTop: 4 }}>
            {entryCount === 0 ? (
              <p className="rank-empty">No income entries for {name}.</p>
            ) : (
              <table className="projects">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Project</th>
                    <th>Note</th>
                    <th className="r">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => {
                    const note =
                      entry.source === 'expected'
                        ? 'Salary — auto-generated'
                        : entry.note && entry.note.trim()
                          ? entry.note
                          : '—';
                    return (
                      <tr key={entry.id}>
                        <td className="num">{formatDayMonth(entry.date)}</td>
                        <td>
                          <Link className="project-link" to={`/projects/${entry.project_id}`}>
                            {entry.name}
                          </Link>
                        </td>
                        <td>{note}</td>
                        <td className="r">{formatMoney(entry.amount, entry.currency)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-h">
            <span className="t">Where {name} came from</span>
            <span className="s">share of total</span>
          </div>
          <div className="panel-b">
            {by_project.length === 0 ? (
              <p className="rank-empty">Nothing to break down yet.</p>
            ) : (
              <>
                <div className="rank">
                  {by_project.map((slice, index) => {
                    const pct = Math.round(slice.share * 100);
                    const width = maxShare > 0 ? (slice.share / maxShare) * 100 : 0;
                    return (
                      <Link
                        key={slice.project_id}
                        className="rank-row"
                        to={`/projects/${slice.project_id}`}
                        aria-label={`${slice.name}: ${pct}% of ${name}, ${formatMoney(
                          slice.total,
                          base_currency,
                        )}`}
                      >
                        <span className="n">
                          {slice.name}
                          <small>{formatMoney(slice.total, base_currency)}</small>
                        </span>
                        <span className="rbar">
                          <i className={index === 0 ? '' : 'mute'} style={{ width: `${width}%` }} />
                        </span>
                        <span className="v num">{pct}%</span>
                      </Link>
                    );
                  })}
                </div>
                {topShare > CONCENTRATION_THRESHOLD && (
                  <div className="comp-note">
                    <span className="warn-flag">Concentration</span>
                    <br />
                    <b>
                      {concentrationPct}% of {name} came from one source.
                    </b>{' '}
                    Not a problem — but worth knowing.
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
