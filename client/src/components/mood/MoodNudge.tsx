// Daily mood nudge — one combined, in-app-only prompt shared by the Dashboard and Projects pages
// (ticket 01 / §2.2). It asks a single calm question, "Which project moved today?", and offers each
// active project as a quick feeling entry in ONE row. Never one prompt per project, never a
// notification: hairline border, no shadow, no badge counts.
//
// The bar walks the projects rather than settling on the first entry: the project up next carries a
// marker dot, and logging it drops it from the row so the next one is marked. The bar closes only
// when every active project has a feeling for today (or the user dismisses it). Projects already
// logged today — here, on the project page, or in the Weekly Close — never appear, so a reload
// resumes mid-way instead of asking twice.
//
// It shows only when at least one active project is still unlogged today and it is not dismissed for
// the day. All fetches are optional garnish — any failure simply renders nothing, never blocking the
// host page.

import { useEffect, useState } from 'react';
import type { Feeling, ProjectWithMetrics } from '../../types';
import { getMoodToday, logProjectMood } from '../../api/moods';
import { listProjects } from '../../api/projects';
import { todayString } from '../../domain/format';
import { FeelingPicker } from '../canvas/FeelingPicker';
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

export function MoodNudge() {
  const [dismissed, setDismissed] = useState(isDismissedToday);
  // Every active project, in list order — the row keeps that order as projects drop out.
  const [projects, setProjects] = useState<ProjectWithMetrics[]>([]);
  // Projects that already have a feeling for today, either from an earlier session or from this bar.
  const [logged, setLogged] = useState<ReadonlySet<number>>(new Set());

  useEffect(() => {
    if (isDismissedToday()) return;
    let cancelled = false;
    Promise.all([getMoodToday(), listProjects({ status: 'active' })])
      .then(([today, rows]) => {
        if (cancelled) return;
        setProjects(rows);
        setLogged(new Set(today.projectIds));
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

  // Logging drops just that project from the row; the bar stays up for the rest. A failed write puts
  // the project back so the ask isn't silently lost.
  function handleLog(projectId: number, value: Feeling | null) {
    setLogged((prev) => new Set(prev).add(projectId));
    logProjectMood(projectId, value, undefined, 'nudge').catch(() => {
      setLogged((prev) => {
        const next = new Set(prev);
        next.delete(projectId);
        return next;
      });
    });
  }

  const pending = projects.filter((p) => !logged.has(p.id));
  if (dismissed || pending.length === 0) return null;

  return (
    <section className="mood-nudge" aria-label="Daily mood check">
      <div className="mood-nudge-q">Which project moved today?</div>
      <div className="mood-nudge-row">
        {pending.map((p, i) => (
          <div className={`mood-nudge-item${i === 0 ? ' is-next' : ''}`} key={p.id}>
            <span className="mood-nudge-dot" aria-hidden="true" />
            <span className="mood-nudge-name">{p.name}</span>
            <div className="mood-pick">
              <FeelingPicker value={null} onChange={(v) => handleLog(p.id, v)} />
            </div>
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
