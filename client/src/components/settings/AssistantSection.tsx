// Assistant usage meter (ticket 12; marketing-strategy §3.5). Shown only on hosted instances that
// have a platform key — SettingsPage gates this whole section (and its nav entry) on
// GET /api/voice/capabilities, so nothing renders for a self-host instance with no key.
//
// The allowance is presented as a PERCENTAGE only — never a raw token count (the API can't even
// return one). Three states, per the ticket:
//   - normal:  "Assistant usage this month: 12% · resets Aug 1" + a hairline progress bar.
//   - ≥80%:    the same, plus one inline "you've used most of this month's allowance" sentence.
//   - capped:  chat paused, voice capture keeps working, plus a link to the fair-use / BYOK policy.

import { useEffect, useState } from 'react';
import { getAssistantUsage, type AssistantUsage } from '../../api/account';

// The canonical fair-use / BYOK policy (source: .claude/docs/fair-use.md → the marketing site).
const FAIR_USE_URL = 'https://github.com/nikoladubica/vorhaben/blob/main/docs/fair-use.md';

// "2026-08-01T00:00:00Z" → "Aug 1". Falls back to the raw string if it can't be parsed.
function formatReset(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function AssistantSection() {
  const [usage, setUsage] = useState<AssistantUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAssistantUsage()
      .then((u) => {
        if (!cancelled) setUsage(u);
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load your assistant usage.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const resetLabel = usage ? formatReset(usage.resetsAt) : '';

  return (
    <div className="set-sec">
      <h4>Assistant</h4>
      <p className="desc">
        Your hosted assistant — voice capture, insights, and chat — is included under a monthly
        fair-use allowance. It’s enough for hundreds of conversations a month; your tracking,
        dashboard, and data are never affected by it.
      </p>

      {loadError ? (
        <p className="form-error" role="alert">
          {loadError}
        </p>
      ) : loading || !usage ? (
        <p className="table-empty">Loading…</p>
      ) : (
        <div style={{ maxWidth: 560 }}>
          <p className="usage-line">
            Assistant usage this month: <strong>{usage.percent}%</strong> · resets {resetLabel}
          </p>

          <div
            className="usage-meter"
            role="progressbar"
            aria-valuenow={usage.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Assistant usage this month"
          >
            <div className="usage-fill" style={{ width: `${usage.percent}%` }} />
          </div>

          {usage.capped ? (
            <p className="set-note" role="status" style={{ marginTop: 16 }}>
              You’ve used this month’s assistant allowance — chat resumes {resetLabel}. Voice capture
              keeps working.{' '}
              <a href={FAIR_USE_URL} target="_blank" rel="noreferrer">
                Read about fair use and using your own API key
              </a>
              .
            </p>
          ) : usage.warning ? (
            <p className="set-note" role="status" style={{ marginTop: 16 }}>
              You’ve used most of this month’s assistant allowance. It resets on {resetLabel}.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
