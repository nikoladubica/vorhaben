// FOCUS CALLOUT — the plain-language "this month's read" (BUSINESS_LOGIC §4.2), ported from the
// design file's `.focus` block (screen 01). The server writes complete sentences and orders
// warnings first, so we render them verbatim in that order. The LABEL maps by SEVERITY, not
// position: a `warning` reads as the emphasized red "Focus" rule, an `info` as the dim grey
// "Watch" — matching the design's two-column example. Keying off severity (not index) keeps the
// red label earned: an all-info callout stays entirely grey, never borrowing a false headline.
//
// Project names referenced by a suggestion are turned into links to their detail pages via
// `project_ids`; when no referenced name is found verbatim in the sentence we fall back to a small
// "View" affordance pointing at the first project. The message text itself is never altered.

import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Suggestion } from '../../api/dashboard';

interface FocusCalloutProps {
  suggestions: Suggestion[];
  nameById: Map<number, string>;
}

interface Match {
  id: number;
  name: string;
  start: number;
  end: number;
}

// Split `message` into text + <Link> nodes wherever a referenced project's name appears verbatim.
// Returns `matched: false` when none were found so the caller can add a fallback affordance.
function linkifyMessage(
  message: string,
  projectIds: number[],
  nameById: Map<number, string>,
): { nodes: ReactNode; matched: boolean } {
  const matches: Match[] = [];
  for (const id of projectIds) {
    const name = nameById.get(id);
    if (!name) continue;
    const start = message.indexOf(name);
    if (start === -1) continue;
    matches.push({ id, name, start, end: start + name.length });
  }

  // Earliest first, then drop any that overlap an already-kept span (defensive against a name that
  // is a substring of another).
  matches.sort((a, b) => a.start - b.start);
  const kept: Match[] = [];
  let guard = 0;
  for (const m of matches) {
    if (m.start >= guard) {
      kept.push(m);
      guard = m.end;
    }
  }

  if (kept.length === 0) {
    return { nodes: message, matched: false };
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;
  kept.forEach((m, i) => {
    if (m.start > cursor) nodes.push(message.slice(cursor, m.start));
    nodes.push(
      <Link key={`${m.id}-${i}`} to={`/projects/${m.id}`}>
        {m.name}
      </Link>,
    );
    cursor = m.end;
  });
  if (cursor < message.length) nodes.push(message.slice(cursor));

  return { nodes: <>{nodes.map((n, i) => <Fragment key={i}>{n}</Fragment>)}</>, matched: true };
}

export function FocusCallout({ suggestions, nameById }: FocusCalloutProps) {
  // Empty array → the whole section disappears (handled by the caller not rendering us, but we
  // also guard here so the component is safe to mount unconditionally).
  if (suggestions.length === 0) return null;

  return (
    <div className="focus">
      <div className="panel-h" style={{ paddingTop: 14 }}>
        <span className="t">This month&#8217;s read</span>
        <span className="s">rules-based · v1 heuristics</span>
      </div>
      <div className="panel-b">
        {suggestions.map((s, index) => {
          const { nodes, matched } = linkifyMessage(s.message, s.project_ids, nameById);
          const fallbackId = s.project_ids[0];
          const isWarning = s.severity === 'warning';
          return (
            <div key={`${s.rule}-${index}`}>
              <span className={isWarning ? 'k' : 'k dim'}>
                {isWarning ? 'Focus' : 'Watch'}
              </span>
              <p>
                {nodes}
                {!matched && fallbackId !== undefined && (
                  <>
                    {' '}
                    <Link className="focus-view" to={`/projects/${fallbackId}`}>
                      View project
                    </Link>
                  </>
                )}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
