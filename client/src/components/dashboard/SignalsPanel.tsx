// SIGNALS PANEL — the First Signal read (breaktrough.md §2.3–§2.4). Each entry is one plain,
// render-ready sentence from the mood analysis engine; the words ARE the interface, so no numbers
// and no charts appear here. The server omits silent projects and orders them most-concerning
// first, so the array renders verbatim — no client-side sort or filter. Red stays reserved: a
// down-signal is --ink text, never an alarm. At most three sentences show; the rest collapse behind
// a "…and N more" toggle (state only, no navigation). Each row links to its project. An empty list
// renders nothing at all — no header, no "all quiet" filler.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Signal } from '../../api/signals';

interface SignalsPanelProps {
  signals: Signal[];
}

// How many sentences show before the rest fold away — a quiet glance, not the full ledger.
const PREVIEW_COUNT = 3;

export function SignalsPanel({ signals }: SignalsPanelProps) {
  const [expanded, setExpanded] = useState(false);

  // Empty state: the whole panel disappears (the caller mounts us unconditionally, so we guard).
  if (signals.length === 0) return null;

  const hidden = signals.length - PREVIEW_COUNT;
  const shown = expanded ? signals : signals.slice(0, PREVIEW_COUNT);

  return (
    <div className="panel signals">
      <div className="panel-h">
        <span className="t">Signals</span>
        <span className="s">what your moods are saying</span>
      </div>
      <div className="panel-b">
        <ul className="signal-list">
          {shown.map((s) => (
            <li key={s.project_id} className="signal-row">
              <Link className="signal-link" to={`/projects/${s.project_id}`}>
                {s.sentence}
              </Link>
            </li>
          ))}
        </ul>
        {hidden > 0 && (
          <button
            type="button"
            className="signal-more"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Show fewer' : `…and ${hidden} more`}
          </button>
        )}
      </div>
    </div>
  );
}
