// Weekly Close settings (ticket 04 / §2.5): the day of the week the "close the week" banner starts
// appearing. Self-contained — it reads the current preference from GET /closes/current (which
// carries close_day) and writes it via PATCH /closes/settings, so it never needs the close_day on
// the auth session. Default is Sunday. Plain sentence explains what it controls; no gamification.

import { useEffect, useState } from 'react';
import { getCloseCurrent, updateWeekStart } from '../../api/closes';

// 0 = Sunday … 6 = Saturday, matching the server's close_day (JS getDay order).
const DAYS: { value: number; label: string }[] = [
  { value: 0, label: 'Sunday' },
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
];

// 0 = Sunday, 1 = Monday — the only two first-day-of-week options the server accepts.
const WEEK_STARTS: { value: number; label: string }[] = [
  { value: 1, label: 'Monday' },
  { value: 0, label: 'Sunday' },
];

export function CloseSettingsSection() {
  const [saved, setSaved] = useState<number | null>(null);
  const [choice, setChoice] = useState<number>(0);
  const [savedWeekStart, setSavedWeekStart] = useState<number | null>(null);
  const [weekStart, setWeekStart] = useState<number>(1);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getCloseCurrent()
      .then((state) => {
        if (cancelled) return;
        setSaved(state.close_day);
        setChoice(state.close_day);
        setSavedWeekStart(state.week_start);
        setWeekStart(state.week_start);
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load your weekly-close settings.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty =
    saved !== null &&
    savedWeekStart !== null &&
    (choice !== saved || weekStart !== savedWeekStart);
  const canSave = dirty && !pending;

  async function onSave() {
    setError(null);
    setJustSaved(false);
    setPending(true);
    try {
      // One PATCH persists both preferences (the endpoint always takes close_day; week_start is
      // sent alongside it). Keeps the two independent — changing the week start never mutates the
      // close day.
      const res = await updateWeekStart(weekStart, choice);
      setSaved(res.close_day);
      setSavedWeekStart(res.week_start);
      setJustSaved(true);
    } catch {
      setError('Could not save your weekly-close settings. Please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="set-sec">
      <h4>Weekly Close</h4>
      <p className="desc">
        The Weekly Close is a calm, once-a-week walk through your active projects — a feeling, an
        optional note, and a glance at the week’s numbers. Pick the day it should start reminding
        you; a missed week costs nothing.
      </p>

      {loadError ? (
        <p className="form-error" role="alert">
          {loadError}
        </p>
      ) : loading ? (
        <p className="table-empty">Loading…</p>
      ) : (
        <>
          <div className="fgrid" style={{ maxWidth: 560 }}>
            <label className="field">
              <span>First day of the week</span>
              <select
                value={weekStart}
                onChange={(e) => {
                  setWeekStart(Number(e.target.value));
                  setJustSaved(false);
                  setError(null);
                }}
              >
                {WEEK_STARTS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
              <span className="field-hint">
                Your week starts on this day. The close reminder appears from your close day until
                you close the week.
              </span>
            </label>
            <label className="field">
              <span>Close day</span>
              <select
                value={choice}
                onChange={(e) => {
                  setChoice(Number(e.target.value));
                  setJustSaved(false);
                  setError(null);
                }}
              >
                {DAYS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {error && (
            <p className="form-error" role="alert" style={{ marginTop: 12 }}>
              {error}
            </p>
          )}

          <div className="pd-actions" style={{ marginTop: 18 }}>
            <button type="button" className="btn primary sm" disabled={!canSave} onClick={onSave}>
              {pending ? 'Saving…' : 'Save'}
            </button>
            {justSaved && !dirty && <span className="field-hint">Saved.</span>}
          </div>
        </>
      )}
    </div>
  );
}
