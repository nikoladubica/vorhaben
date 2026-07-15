// Mood block for the project-detail screen (ticket 01 / §2.2, split by ticket 27). Shows the
// project's current feeling AND trend and lets the user change either by REUSING the shared
// CheckInRow (the same two-question unit the nudge and Weekly Close use) — there is no second set of
// pickers. On a pick, an optional one-line "why?" input appears; Save logs the change with the note,
// Skip logs it without one — the note rides the event whichever question it answers. "Didn't touch
// it" logs immediately (there is nothing to annotate). All writes go through POST /projects/:id/moods
// (the one write path). Below, the stream renders every kind in one list, newest first: feeling
// entries as the word, trend entries with their glyph + word, untouched entries as "Didn't touch it"
// — no visual escalation. Presentational + self-contained: it owns its own load/log state and never
// mutates the parent project object.

import { useEffect, useRef, useState } from 'react';
import type { Feeling, MoodEvent, MoodKind, Trend } from '../../types';
import type { Signal } from '../../api/signals';
import { listProjectMoods, logProjectMood } from '../../api/moods';
import { formatRelativeTime } from '../../domain/format';
import { CheckInRow } from './CheckInRow';
import { TREND_LABEL } from '../canvas/trendMeta';
import './mood.css';

interface MoodSectionProps {
  projectId: number;
  // The project's current feeling and trend (the denormalized column values) — the starting display.
  feeling: Feeling | null;
  trend: Trend | null;
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

// 'excited' → 'Excited' for display; state stays lowercase enum values. Works for legacy feelings too.
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// One stream entry's label, by kind: a feeling reads as the word, a trend as its glyph + word
// ("▲ Good"), an untouched entry as "Didn't touch it". A cleared feeling/trend (null value) reads
// "Cleared". Legacy feelings still render — they are only barred from the picker, never from history.
function streamLabel(ev: MoodEvent): string {
  if (ev.kind === 'untouched') return 'Didn’t touch it';
  if (ev.value === null) return 'Cleared';
  if (ev.kind === 'trend') return TREND_LABEL[ev.value as Trend] ?? capitalize(ev.value);
  return capitalize(ev.value);
}

// A pick awaiting its optional "why". A discriminated union so `value` narrows to the right type per
// question; `value` may be null (a Clear), so we box it rather than use null to mean "no pending".
type Pending = { kind: 'feeling'; value: Feeling | null } | { kind: 'trend'; value: Trend | null };

export function MoodSection({ projectId, feeling, trend, signal }: MoodSectionProps) {
  const [current, setCurrent] = useState<Feeling | null>(feeling);
  const [currentTrend, setCurrentTrend] = useState<Trend | null>(trend);
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
    setCurrentTrend(trend);
  }, [trend]);

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

  // Log an "didn't touch it" answer immediately — there is nothing to annotate, so it skips the why
  // row entirely. It touches neither current column; it only appends to the stream.
  async function logUntouched() {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const created = await logProjectMood(projectId, null, undefined, undefined, 'untouched');
      setEvents((prev) => [created, ...prev].slice(0, STREAM_LIMIT));
      setPending(null);
      setNote('');
    } catch {
      setSaveError('Could not save this. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  // Picking a feeling or trend doesn't write yet — it opens the optional "why" row. The picker's own
  // button reflects the pending value so the user sees their choice before deciding to annotate it.
  function handleLog(kind: MoodKind, value: Feeling | Trend | null) {
    if (kind === 'untouched') {
      void logUntouched();
      return;
    }
    setSaveError(null);
    setNote('');
    setPending(
      kind === 'feeling'
        ? { kind: 'feeling', value: value as Feeling | null }
        : { kind: 'trend', value: value as Trend | null },
    );
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
        undefined,
        pending.kind,
      );
      if (pending.kind === 'feeling') setCurrent(pending.value);
      else setCurrentTrend(pending.value);
      setEvents((prev) => [created, ...prev].slice(0, STREAM_LIMIT));
      setPending(null);
      setNote('');
    } catch {
      setSaveError('Could not save this mood. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  // Reflect the pending pick on the relevant trigger; the other trigger keeps its current value.
  const shownFeeling = pending?.kind === 'feeling' ? pending.value : current;
  const shownTrend = pending?.kind === 'trend' ? pending.value : currentTrend;

  return (
    <div className="panel mood-panel">
      <div className="panel-h">
        <span className="t">Mood</span>
        <span className="s">how it feels</span>
      </div>
      <div className="panel-b">
        <div className="mood-set">
          <CheckInRow
            feeling={shownFeeling}
            trend={shownTrend}
            feelingAnswered={current !== null}
            trendAnswered={currentTrend !== null}
            untouched={false}
            onLog={handleLog}
          />

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
                  <span className="mood-ev-v">{streamLabel(ev)}</span>
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
