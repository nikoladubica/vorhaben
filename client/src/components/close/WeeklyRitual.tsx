// Coordinator for the two quiet weekly banners on the Dashboard and Projects pages: the Weekly
// Close banner (ticket 04) and the daily MoodNudge (ticket 01). They share one slot and must NEVER
// stack — the close banner wins during its window. This component decides which single banner (if
// any) renders, so the host pages just drop in <WeeklyRitual /> in place of the bare <MoodNudge />.
//
// Decision:
//   1. If the close banner is dismissed for today, or its state can't be read, fall back to the
//      MoodNudge (which makes its own show/hide decision).
//   2. Otherwise fetch the close state: when `in_window` is true (today ≥ the user's close day and
//      the week isn't closed yet) show the CloseBanner; else fall back to the MoodNudge.
// While the close state is still resolving we render nothing, so neither banner flashes then swaps.

import { useEffect, useState } from 'react';
import { getCloseCurrent } from '../../api/closes';
import { todayString } from '../../domain/format';
import { MoodNudge } from '../mood/MoodNudge';
import { CloseBanner } from './CloseBanner';

// Per-day dismissal key — date-stamped so the banner returns on its own the next day (mirrors the
// MoodNudge dismissal pattern).
function dismissKey(): string {
  return `close-banner-dismissed:${todayString()}`;
}

function isDismissedToday(): boolean {
  try {
    return localStorage.getItem(dismissKey()) === '1';
  } catch {
    return false;
  }
}

// null = still deciding; 'close' = show the close banner; 'mood' = fall back to the MoodNudge.
type Decision = null | 'close' | 'mood';

export function WeeklyRitual() {
  const [decision, setDecision] = useState<Decision>(null);

  useEffect(() => {
    // Dismissed for the day → never even ask, just hand the slot to the MoodNudge.
    if (isDismissedToday()) {
      setDecision('mood');
      return;
    }
    let cancelled = false;
    getCloseCurrent()
      .then((state) => {
        if (cancelled) return;
        setDecision(state.in_window ? 'close' : 'mood');
      })
      .catch(() => {
        // The close state is optional garnish — a failure simply defers to the MoodNudge.
        if (!cancelled) setDecision('mood');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function dismissClose() {
    try {
      localStorage.setItem(dismissKey(), '1');
    } catch {
      // Private mode / storage disabled — dismiss for this view anyway.
    }
    // Dismissing the close banner hands the slot back to the MoodNudge for the rest of the day.
    setDecision('mood');
  }

  if (decision === null) return null;
  if (decision === 'close') return <CloseBanner onDismiss={dismissClose} />;
  return <MoodNudge />;
}
