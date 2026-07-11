// Mood block for the project-detail screen (ticket 01 / §2.2). Shows the project's current feeling
// and lets the user change it by REUSING the canvas FeelingPicker — there is no second picker. On
// pick, an optional one-line "why?" input appears; Save logs the change with the note, Skip logs it
// without one. Both go through POST /projects/:id/moods (the note-carrying path). Below, the last
// few stream entries render as a quiet hairline list. Presentational + self-contained: it owns its
// own load/log state and never mutates the parent project object.

import { useEffect, useRef, useState } from 'react';
import type { Feeling, MoodEvent } from '../../types';
import type { Signal } from '../../api/signals';
import { listProjectMoods, logProjectMood } from '../../api/moods';
import { formatRelativeTime } from '../../domain/format';
import { FeelingPicker } from '../canvas/FeelingPicker';
import './mood.css';

interface MoodSectionProps {
  projectId: number;
  // The project's current feeling (the denormalized column value) — the starting display.
  feeling: Feeling | null;
  // This project's First Signal (breaktrough.md §2.3–§2.4), or null when the engine has nothing to
  // say yet. Rendered as words under the stream — never numbers, never red.
  signal: Signal | null;
}

// How many recent stream entries to show — a quiet glance at history, not the full ledger.
const STREAM_LIMIT = 10;

// confidence → the eyebrow's leading phrase. The "· N DAYS OF DATA" suffix (most meaningful for an
// early signal) is appended from `days`; CSS upper-cases the whole line to the 11px eyebrow style.
const CONFIDENCE_LABEL: Record<Signal['confidence'], string> = {
  early: 'Early signal',
  pattern: 'Pattern',
  established: 'Established trend',
};

// 'excited' → 'Excited' for display; state stays lowercase enum values. A cleared feeling (null)
// reads as "Cleared" in the stream.
function feelingLabel(value: Feeling | null): string {
  if (value === null) return 'Cleared';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// A pick awaiting its optional "why" — `value` may be null (a Clear), so we box it rather than use
// null to mean "no pending pick".
type Pending = { value: Feeling | null };

export function MoodSection({ projectId, feeling, signal }: MoodSectionProps) {
  const [current, setCurrent] = useState<Feeling | null>(feeling);
  const [events, setEvents] = useState<MoodEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [pending, setPending] = useState<Pending | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const whyInputRef = useRef<HTMLInputElement>(null);

  // Keep the current display in step if the parent reloads the project (e.g. after a status change
  // refetches the row).
  useEffect(() => {
    setCurrent(feeling);
  }, [feeling]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    listProjectMoods(projectId, STREAM_LIMIT)
      .then((rows) => {
        if (!cancelled) setEvents(rows);
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load the mood history.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Picking a feeling doesn't write yet — it opens the optional "why" row. The picker's own button
  // reflects the pending value so the user sees their choice before deciding to annotate it.
  function handlePick(value: Feeling | null) {
    setSaveError(null);
    setNote('');
    setPending({ value });
    // Focus the why input once it mounts.
    window.setTimeout(() => whyInputRef.current?.focus(), 0);
  }

  async function submit(withNote: boolean) {
    if (!pending || saving) return;
    const trimmed = note.trim();
    setSaving(true);
    setSaveError(null);
    try {
      const created = await logProjectMood(
        projectId,
        pending.value,
        withNote && trimmed ? trimmed : undefined,
      );
      setCurrent(pending.value);
      setEvents((prev) => [created, ...prev].slice(0, STREAM_LIMIT));
      setPending(null);
      setNote('');
    } catch {
      setSaveError('Could not save this mood. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="panel mood-panel">
      <div className="panel-h">
        <span className="t">Mood</span>
        <span className="s">how it feels</span>
      </div>
      <div className="panel-b">
        <div className="mood-set">
          <div className="mood-pick">
            <FeelingPicker value={pending ? pending.value : current} onChange={handlePick} />
          </div>

          {pending && (
            <form
              className="mood-why"
              onSubmit={(e) => {
                e.preventDefault();
                void submit(true);
              }}
            >
              <input
                ref={whyInputRef}
                type="text"
                className="mood-why-in"
                aria-label="Why? (optional)"
                placeholder="Why? (optional)"
                maxLength={1000}
                value={note}
                disabled={saving}
                onChange={(e) => setNote(e.target.value)}
              />
              <button type="submit" className="btn ghost sm" disabled={saving}>
                Save
              </button>
              <button
                type="button"
                className="btn ghost sm"
                disabled={saving}
                onClick={() => void submit(false)}
              >
                Skip
              </button>
            </form>
          )}
        </div>

        {saveError && (
          <p className="form-error" role="alert">
            {saveError}
          </p>
        )}

        {loading ? (
          <p className="table-empty">Loading…</p>
        ) : loadError ? (
          <p className="form-error" role="alert">
            {loadError}
          </p>
        ) : events.length === 0 ? (
          <p className="table-empty">No mood logged yet.</p>
        ) : (
          <ul className="mood-stream">
            {events.map((ev) => (
              <li key={ev.id} className="mood-ev">
                <div className="mood-ev-top">
                  <span className="mood-ev-v">{feelingLabel(ev.value)}</span>
                  <span className="mood-ev-d num">{formatRelativeTime(ev.created_at)}</span>
                </div>
                {ev.note && <p className="mood-ev-n">{ev.note}</p>}
              </li>
            ))}
          </ul>
        )}

        {signal && (
          <div className="mood-signal">
            <span className="mood-signal-eyebrow">
              {CONFIDENCE_LABEL[signal.confidence]} · {signal.days}{' '}
              {signal.days === 1 ? 'day' : 'days'} of data
            </span>
            <p className="mood-signal-text">{signal.sentence}</p>
          </div>
        )}
      </div>
    </div>
  );
}
