// SIGNALS PANEL — the First Signal read (breaktrough.md §2.3–§2.4) plus drift nudges (§2.7). Each
// entry is one plain, render-ready sentence; the words ARE the interface, so no numbers and no
// charts appear here. The server omits silent projects and orders them most-concerning first, so
// the arrays render verbatim — no client-side sort or filter. Red stays reserved: neither a
// down-signal nor a nudge ever renders in red — they are --ink text, never an alarm.
//
// Nudges render first (they prompt a decision, not just a read), then the signal sentences with the
// unchanged preview/expand behaviour. An `attention_drift` nudge also offers a direct "End it →"
// path into the ending ritual; `feeling_drift` links only to the project. An empty panel (no
// nudges, no signals) renders nothing at all — no header, no "all quiet" filler.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Nudge, Signal } from '../../api/signals';

interface SignalsPanelProps {
  signals: Signal[];
  nudges: Nudge[];
}

// How many sentences show before the rest fold away — a quiet glance, not the full ledger.
const PREVIEW_COUNT = 3;

export function SignalsPanel({ signals, nudges }: SignalsPanelProps) {
  const [expanded, setExpanded] = useState(false);

  // Empty state: the whole panel disappears (the caller mounts us unconditionally, so we guard).
  if (signals.length === 0 && nudges.length === 0) return null;

  const hidden = signals.length - PREVIEW_COUNT;
  const shown = expanded ? signals : signals.slice(0, PREVIEW_COUNT);
  const bothGroups = nudges.length > 0 && signals.length > 0;

  return (
    <div className="panel signals">
      <div className="panel-h">
        <span className="t">Signals</span>
        <span className="s">what your moods are saying</span>
      </div>
      <div className="panel-b">
        <ul className="signal-list">
          {nudges.map((n) => (
            <li key={`nudge-${n.project_id}-${n.kind}`} className="signal-row nudge-row">
              <Link className="signal-link" to={`/projects/${n.project_id}`}>
                {n.sentence}
              </Link>
              {n.kind === 'attention_drift' && (
                <Link className="nudge-end" to={`/projects/${n.project_id}/end`}>
                  End it →
                </Link>
              )}
            </li>
          ))}
          {shown.map((s, i) => (
            <li
              key={s.project_id}
              className={`signal-row${i === 0 && bothGroups ? ' divide' : ''}`}
            >
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
