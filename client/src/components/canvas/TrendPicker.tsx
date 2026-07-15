// Trend picker (screen 14 + the check-in surfaces). Presentational + prop-driven — no API calls; the
// host owns persistence via `onChange`. The trigger is a real <button> (skipped by the card drag
// handler) showing the current trend with its SEMANTIC treatment — thriving/good in --good, stable
// in --ink-3, bad/failing in --ink — NEVER the red accent (failing is information, not an alarm).
// Clicking opens a hairline `.cv-menu` with the 5 closed-list options + a Clear row. Closes on pick,
// outside-click, and Escape.

import { useRef, useState } from 'react';
import type { Trend } from '../../types';
import { TRENDS } from '../../types';
import { TREND_CLASS, TREND_LABEL } from './trendMeta';
import { useDismiss } from './useDismiss';

interface Props {
  value: Trend | null;
  onChange: (trend: Trend | null) => void;
}

export function TrendPicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useDismiss(open, wrapRef, () => setOpen(false));

  function pick(trend: Trend | null) {
    onChange(trend);
    setOpen(false);
  }

  const triggerClass = value ? `cv-tag trd ${TREND_CLASS[value]}` : 'cv-tag trd';

  return (
    <div className="cv-pick" ref={wrapRef}>
      <button
        type="button"
        className={triggerClass}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {value ? (
          TREND_LABEL[value]
        ) : (
          <>
            <span className="pre">Trend</span> —
          </>
        )}
      </button>

      {open && (
        <div className="cv-menu" role="menu" aria-label="Trend">
          <div className="mh">How is it going?</div>
          {TRENDS.map((t) => (
            <button
              key={t}
              type="button"
              role="menuitemradio"
              aria-checked={value === t}
              className={`${TREND_CLASS[t]}${value === t ? ' on' : ''}`}
              onClick={() => pick(t)}
            >
              {TREND_LABEL[t]}
            </button>
          ))}
          <button type="button" role="menuitem" className="mclear" onClick={() => pick(null)}>
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
