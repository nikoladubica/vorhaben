// Daily mood nudge — one combined, in-app-only prompt shared by the Dashboard and Projects pages
// (ticket 01 / §2.2, split into two questions by ticket 27). It asks a single calm question, "Which
// project moved today?", and offers each active project as ONE two-question check-in row (trend +
// feeling + a quiet "Didn't touch it"). Never one prompt per project, never a notification: hairline
// border, no shadow, no badge counts.
//
// The bar walks the projects rather than settling on the first entry: the project up next carries a
// marker dot, and a project drops out of the row once BOTH its questions are covered today — either
// answered directly or resolved by "didn't touch it". The bar closes only when every active project
// is fully covered (or the user dismisses it for the day). Coverage is read per kind from
// getMoodToday, so projects already covered earlier — here, on the project page, or in the Weekly
// Close — never reappear, and a reload resumes mid-way instead of asking twice.
//
// It shows only when at least one active project still has an outstanding question today and it is
// not dismissed for the day. All fetches are optional garnish — any failure simply renders nothing,
// never blocking the host page.

import { useEffect, useState } from 'react';
import type { Feeling, MoodKind, ProjectWithMetrics, Trend } from '../../types';
import { getMoodToday, logProjectMood } from '../../api/moods';
import { listProjects } from '../../api/projects';
import { todayString } from '../../domain/format';
import { CheckInRow } from './CheckInRow';
import './mood.css';

// Per-day dismissal key — includes the date so the nudge returns tomorrow on its own.
function dismissKey(): string {
  return `mood-nudge-dismissed:${todayString()}`;
}

function isDismissedToday(): boolean {
  try {
    return localStorage.getItem(dismissKey()) === '1';
  } catch {
    return false;
  }
}

// Add / remove one id from a Set immutably (so React sees a new reference).
function withId(prev: ReadonlySet<number>, id: number): Set<number> {
  return new Set(prev).add(id);
}
function withoutId(prev: ReadonlySet<number>, id: number): Set<number> {
  const next = new Set(prev);
  next.delete(id);
  return next;
}

export function MoodNudge() {
  const [dismissed, setDismissed] = useState(isDismissedToday);
  // Every active project, in list order — the row keeps that order as projects drop out.
  const [projects, setProjects] = useState<ProjectWithMetrics[]>([]);
  // Per-kind coverage for today. `untouched` covers BOTH questions on its own.
  const [feelingDone, setFeelingDone] = useState<ReadonlySet<number>>(new Set());
  const [trendDone, setTrendDone] = useState<ReadonlySet<number>>(new Set());
  const [untouchedDone, setUntouchedDone] = useState<ReadonlySet<number>>(new Set());
  // Values picked in THIS session, overlaying the project's stored value so a just-answered picker
  // shows the new choice while the row waits on its other question.
  const [feelingVal, setFeelingVal] = useState<ReadonlyMap<number, Feeling | null>>(new Map());
  const [trendVal, setTrendVal] = useState<ReadonlyMap<number, Trend | null>>(new Map());

  useEffect(() => {
    if (isDismissedToday()) return;
    let cancelled = false;
    Promise.all([getMoodToday(), listProjects({ status: 'active' })])
      .then(([today, rows]) => {
        if (cancelled) return;
        setProjects(rows);
        setFeelingDone(new Set(today.feelingProjectIds));
        setTrendDone(new Set(today.trendProjectIds));
        setUntouchedDone(new Set(today.untouchedProjectIds));
      })
      .catch(() => {
        // Leave the bar empty — the nudge is garnish and must never block the page.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function dismiss() {
    try {
      localStorage.setItem(dismissKey(), '1');
    } catch {
      // Private mode / storage disabled — dismiss for this view anyway.
    }
    setDismissed(true);
  }

  // Answering one question covers just that kind (or, for "didn't touch it", the whole row); the bar
  // keeps the project until both questions are covered. A failed write restores only the failed kind
  // so the ask isn't silently lost and the other answer isn't disturbed.
  function handleLog(projectId: number, kind: MoodKind, value: Feeling | Trend | null) {
    if (kind === 'untouched') {
      setUntouchedDone((prev) => withId(prev, projectId));
      logProjectMood(projectId, null, undefined, 'nudge', 'untouched').catch(() => {
        setUntouchedDone((prev) => withoutId(prev, projectId));
      });
      return;
    }
    if (kind === 'feeling') {
      const v = value as Feeling | null;
      setFeelingDone((prev) => withId(prev, projectId));
      setFeelingVal((prev) => new Map(prev).set(projectId, v));
      logProjectMood(projectId, v, undefined, 'nudge', 'feeling').catch(() => {
        setFeelingDone((prev) => withoutId(prev, projectId));
      });
      return;
    }
    const v = value as Trend | null;
    setTrendDone((prev) => withId(prev, projectId));
    setTrendVal((prev) => new Map(prev).set(projectId, v));
    logProjectMood(projectId, v, undefined, 'nudge', 'trend').catch(() => {
      setTrendDone((prev) => withoutId(prev, projectId));
    });
  }

  function feelingCovered(id: number): boolean {
    return untouchedDone.has(id) || feelingDone.has(id);
  }
  function trendCovered(id: number): boolean {
    return untouchedDone.has(id) || trendDone.has(id);
  }
  function fullyCovered(id: number): boolean {
    return untouchedDone.has(id) || (feelingDone.has(id) && trendDone.has(id));
  }

  const pending = projects.filter((p) => !fullyCovered(p.id));
  if (dismissed || pending.length === 0) return null;

  return (
    <section className="mood-nudge" aria-label="Daily mood check">
      <div className="mood-nudge-q">Which project moved today?</div>
      <div className="mood-nudge-row">
        {pending.map((p, i) => (
          <div className={`mood-nudge-item${i === 0 ? ' is-next' : ''}`} key={p.id}>
            <span className="mood-nudge-dot" aria-hidden="true" />
            <CheckInRow
              name={p.name}
              feeling={feelingVal.has(p.id) ? (feelingVal.get(p.id) ?? null) : p.feeling}
              trend={trendVal.has(p.id) ? (trendVal.get(p.id) ?? null) : p.trend}
              feelingAnswered={feelingCovered(p.id)}
              trendAnswered={trendCovered(p.id)}
              untouched={untouchedDone.has(p.id)}
              onLog={(kind, value) => handleLog(p.id, kind, value)}
            />
          </div>
        ))}
      </div>
      <button
        type="button"
        className="mood-nudge-x"
        aria-label="Dismiss for today"
        onClick={dismiss}
      >
        ×
      </button>
    </section>
  );
}
