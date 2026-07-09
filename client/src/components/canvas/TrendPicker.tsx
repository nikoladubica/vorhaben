// Trend picker for a canvas card (screen 14). Presentational + prop-driven — no API calls; the page
// owns persistence via `onChange`. The trigger is a real <button> (skipped by the card drag handler)
// showing the current trend with its SEMANTIC treatment — ▲ Good in --good, ▬ Stable in --ink-3,
// ▼ Bad in --ink — never the red accent. Clicking opens a hairline `.cv-menu` with the 3 closed-list
// options + a Clear row. Closes on pick, outside-click, and Escape.

import { useRef, useState } from 'react';
import type { Trend } from '../../types';
import { useDismiss } from './useDismiss';

const TRENDS: Trend[] = ['good', 'stable', 'bad'];

// Glyph + label per trend, matching the design (▲ Good / ▬ Stable / ▼ Bad).
const TREND_LABEL: Record<Trend, string> = {
  good: '▲ Good',
  stable: '▬ Stable',
  bad: '▼ Bad',
};

// Semantic colour class per trend — .t-good (green), .t-stable (muted), .t-bad (ink). Never red.
const TREND_CLASS: Record<Trend, string> = {
  good: 't-good',
  stable: 't-stable',
  bad: 't-bad',
};

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
