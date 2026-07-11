// Weekly Close settings (ticket 04 / §2.5): the day of the week the "close the week" banner starts
// appearing. Self-contained — it reads the current preference from GET /closes/current (which
// carries close_day) and writes it via PATCH /closes/settings, so it never needs the close_day on
// the auth session. Default is Sunday. Plain sentence explains what it controls; no gamification.

import { useEffect, useState } from 'react';
import { getCloseCurrent, updateCloseDay } from '../../api/closes';

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

export function CloseSettingsSection() {
  const [saved, setSaved] = useState<number | null>(null);
  const [choice, setChoice] = useState<number>(0);
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

  const dirty = saved !== null && choice !== saved;
  const canSave = dirty && !pending;

  async function onSave() {
    setError(null);
    setJustSaved(false);
    setPending(true);
    try {
      const res = await updateCloseDay(choice);
      setSaved(res.close_day);
      setJustSaved(true);
    } catch {
      setError('Could not save your close day. Please try again.');
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
              {pending ? 'Saving…' : 'Save close day'}
            </button>
            {justSaved && !dirty && <span className="field-hint">Saved.</span>}
          </div>
        </>
      )}
    </div>
  );
}
