// A small popover for the canvas connection flow (screen 14) — used both to CHOOSE a relationship
// after dragging one card onto another and to EDIT an existing connection at its midpoint label.
// Presentational + prop-driven: it renders a list of action rows and closes on pick, outside-click,
// and Escape (the shared useDismiss). It holds no state and makes no API calls; every choice is
// forwarded up. Reuses the .cv-menu token styling; no red anywhere (a connection is never an alarm).

import { useRef } from 'react';
import type { CSSProperties } from 'react';
import { useDismiss } from './useDismiss';

export interface LinkOption {
  key: string;
  label: string;
  // A trailing muted hint (e.g. the direction sentence) shown under the label.
  hint?: string;
  // Renders the row as a quiet separated "remove" action rather than a type choice.
  separated?: boolean;
  onSelect: () => void;
}

interface Props {
  title: string;
  // Absolute position within the positioned .cv-board (board-space px of the drop point / midpoint).
  style: CSSProperties;
  options: LinkOption[];
  onDismiss: () => void;
}

export function LinkPopover({ title, style, options, onDismiss }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(true, ref, onDismiss);

  return (
    <div className="cv-menu cv-link-menu" style={style} role="menu" aria-label={title} ref={ref}>
      <div className="mh">{title}</div>
      {options.map((opt) => (
        <button
          key={opt.key}
          type="button"
          role="menuitem"
          className={opt.separated ? 'lp-row lp-sep' : 'lp-row'}
          onClick={opt.onSelect}
        >
          <span className="lp-label">{opt.label}</span>
          {opt.hint && <span className="lp-hint">{opt.hint}</span>}
        </button>
      ))}
    </div>
  );
}
