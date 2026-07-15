// Feeling picker for a canvas card (screen 14) and the check-in surfaces. Presentational +
// prop-driven — it never calls the API; the host owns persistence and passes `onChange`. The trigger
// is a real <button> (so the card drag handler skips it via closest('button')); clicking it toggles
// a hairline `.cv-menu` popover of the 6 WRITABLE feelings in a 2-col grid, plus a Clear row. Closes
// on pick, outside-click, and Escape.
//
// The list shrank to 6 (owner decision 2026-07-14): the retired words (grateful, opportunistic,
// pessimistic) are never offered here, but a project still holding a legacy value shows it on the
// trigger — history renders, it just can't be re-picked.

import { useRef, useState } from 'react';
import type { Feeling } from '../../types';
import { FEELINGS } from '../../types';
import { useDismiss } from './useDismiss';

// 'excited' → 'Excited' for display; state stays lowercase enum values. Works for legacy values too,
// so a legacy feeling still capitalizes correctly on the trigger.
function capitalize(f: Feeling): string {
  return f.charAt(0).toUpperCase() + f.slice(1);
}

interface Props {
  value: Feeling | null;
  onChange: (feeling: Feeling | null) => void;
}

export function FeelingPicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useDismiss(open, wrapRef, () => setOpen(false));

  function pick(feeling: Feeling | null) {
    onChange(feeling);
    setOpen(false);
  }

  return (
    <div className="cv-pick" ref={wrapRef}>
      <button
        type="button"
        className="cv-tag feel"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="pre">Feeling</span> {value ? capitalize(value) : '—'}
      </button>

      {open && (
        <div className="cv-menu" role="menu" aria-label="Feeling">
          <div className="mh">How do you feel about it?</div>
          <div className="mg">
            {FEELINGS.map((f) => (
              <button
                key={f}
                type="button"
                role="menuitemradio"
                aria-checked={value === f}
                className={value === f ? 'on' : undefined}
                onClick={() => pick(f)}
              >
                {capitalize(f)}
              </button>
            ))}
          </div>
          <button type="button" role="menuitem" className="mclear" onClick={() => pick(null)}>
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
