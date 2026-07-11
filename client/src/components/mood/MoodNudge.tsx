// Daily mood nudge — one combined, in-app-only prompt shared by the Dashboard and Projects pages
// (ticket 01 / §2.2). It asks a single calm question, "Which project moved today?", and offers each
// active project as a quick feeling entry in ONE row. Never one prompt per project, never a
// notification: hairline border, no red, no animation, no badge counts.
//
// It shows only when nothing has been logged today AND there is at least one active project, and it
// is not dismissed for the day. Logging any mood (or dismissing) hides it. All fetches are optional
// garnish — any failure simply renders nothing, never blocking the host page.

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
  // null = still deciding whether to show; false = hidden; true = show the bar.
  const [visible, setVisible] = useState<boolean | null>(null);
  const [projects, setProjects] = useState<ProjectWithMetrics[]>([]);

  useEffect(() => {
    if (isDismissedToday()) {
      setVisible(false);
      return;
    }
    let cancelled = false;
    Promise.all([getMoodToday(), listProjects({ status: 'active' })])
      .then(([today, rows]) => {
        if (cancelled) return;
        if (today.logged || rows.length === 0) {
          setVisible(false);
          return;
        }
        setProjects(rows);
        setVisible(true);
      })
      .catch(() => {
        if (!cancelled) setVisible(false);
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
    setVisible(false);
  }

  // Logging any mood settles the whole bar for the day — one glance, done.
  function handleLog(projectId: number, value: Feeling | null) {
    setVisible(false);
    logProjectMood(projectId, value).catch(() => {
      // The bar has already closed; a failed quick-entry is recoverable from the project page.
    });
  }

  if (!visible) return null;

  return (
    <section className="mood-nudge" aria-label="Daily mood check">
      <div className="mood-nudge-q">Which project moved today?</div>
      <div className="mood-nudge-row">
        {projects.map((p) => (
          <div className="mood-nudge-item" key={p.id}>
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
