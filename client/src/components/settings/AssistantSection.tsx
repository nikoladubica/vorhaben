// Assistant settings (design 07). Reconciles two tickets:
//   - Ticket 12 (hosted metering): on an instance with a platform LLM key, the fair-use usage meter
//     — percentage only, never a raw token count.
//   - Ticket 13 (plan + BYOK): the caller's hosted plan ($9/mo or $90/yr) or an upgrade CTA, and a
//     self-hoster's bring-your-own provider key (stored encrypted, never echoed back).
//
// What renders depends on the instance:
//   - Platform key present (hosted): intro · plan block · usage meter · bring-your-own-key block.
//   - No platform key (self-host): intro · bring-your-own-key block. No plan, no meter — those are
//     hosted-only, so there is no dead UI (ticket 12's rule still holds).
// The nav entry is always present; this section is always reachable so a self-hoster can set a key.

import { useEffect, useState } from 'react';
import { getCapabilities } from '../../api/capture';
import { getAssistantUsage, type AssistantUsage } from '../../api/account';
import {
  getAssistantSettings,
  saveAssistantKey,
  type AssistantPlan,
  type AssistantSettings,
} from '../../api/settings';
import { PasswordField } from '../PasswordField';

// The canonical fair-use / BYOK policy (source: .claude/docs/fair-use.md → the marketing site).
const FAIR_USE_URL = 'https://github.com/nikoladubica/vorhaben/blob/main/docs/fair-use.md';

const PLAN_PRICE: Record<AssistantPlan, string> = {
  monthly: '$9 / month',
  yearly: '$90 / year',
};

// "2026-08-01T00:00:00Z" → "Aug 1". Falls back to the raw string if it can't be parsed.
function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// A renewal date, spelled out: "4 January 2027". Falls back to the raw string if unparseable.
function formatLongDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

export function AssistantSection() {
  // null = still probing. `hosted` (platform key present) gates the plan block and usage meter.
  const [hosted, setHosted] = useState<boolean | null>(null);
  const [settings, setSettings] = useState<AssistantSettings | null>(null);
  const [usage, setUsage] = useState<AssistantUsage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Bring-your-own-key form. The input starts empty and stays empty after saving — the key is never
  // sent back to us, so there is nothing to prefill.
  const [keyInput, setKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [caps, s] = await Promise.all([getCapabilities(), getAssistantSettings()]);
        if (cancelled) return;
        setHosted(caps.llm);
        setSettings(s);
        // The usage meter is a hosted-only, platform-key feature (ticket 12).
        if (caps.llm) {
          const u = await getAssistantUsage();
          if (!cancelled) setUsage(u);
        }
      } catch {
        if (!cancelled) setLoadError('Could not load your assistant settings.');
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const hasKey = settings?.has_key ?? false;
  const trimmedKey = keyInput.trim();

  async function persistKey(next: string | null) {
    setKeyError(null);
    setJustSaved(false);
    setSaving(true);
    try {
      const updated = await saveAssistantKey(next);
      setSettings(updated);
      setKeyInput('');
      setJustSaved(true);
    } catch {
      setKeyError(
        next === null ? 'Could not remove your key. Please try again.' : 'Could not save your key. Please try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="set-sec">
      <h4>Assistant</h4>
      <p className="desc">
        The assistant reads your projects, entries and notes to suggest where your time is best
        spent. It only ever sees your own data, and nothing is used for training. The rules-based
        insights on your dashboard stay on either way — the assistant adds to them, it never replaces
        them.
      </p>

      {loadError && (
        <p className="form-error" role="alert">
          {loadError}
        </p>
      )}

      {/* Plan block — hosted instances only. */}
      {hosted && settings && (
        <div style={{ maxWidth: 560, marginBottom: 26 }}>
          {settings.plan ? (
            <>
              <p className="usage-line">
                Your plan: <strong>{PLAN_PRICE[settings.plan]}</strong>
                {settings.renews_at ? ` · renews ${formatLongDate(settings.renews_at)}` : ''}
              </p>
              <div className="pd-actions">
                <a className="btn ghost sm" href="/pricing">
                  Manage plan
                </a>
              </div>
            </>
          ) : (
            <>
              <p className="usage-line">
                You’re on the free plan. The hosted assistant is <strong>$9 / month</strong> or{' '}
                <strong>$90 / year</strong>.
              </p>
              <div className="pd-actions">
                <a className="btn primary sm" href="/pricing">
                  Upgrade
                </a>
              </div>
            </>
          )}
        </div>
      )}

      {/* Usage meter — hosted, platform-key only (ticket 12). Percentage, never a token count. */}
      {hosted && usage && (
        <div style={{ maxWidth: 560, marginBottom: 26 }}>
          <p className="usage-line">
            Assistant usage this month: <strong>{usage.percent}%</strong> · resets{' '}
            {formatShortDate(usage.resetsAt)}
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
              You’ve used this month’s assistant allowance — chat resumes{' '}
              {formatShortDate(usage.resetsAt)}. Voice capture keeps working.{' '}
              <a href={FAIR_USE_URL} target="_blank" rel="noreferrer">
                Read about fair use and using your own API key
              </a>
              .
            </p>
          ) : usage.warning ? (
            <p className="set-note" role="status" style={{ marginTop: 16 }}>
              You’ve used most of this month’s assistant allowance. It resets on{' '}
              {formatShortDate(usage.resetsAt)}.
            </p>
          ) : null}
        </div>
      )}

      {/* Bring your own key — always available (the path a self-hoster uses to turn the assistant on). */}
      <h4>Bring your own key</h4>
      <p className="desc">
        Paste an API key from your LLM provider and the assistant runs against your account directly
        {hosted ? ' — no plan or usage limits involved.' : '.'}
      </p>

      <div className="fgrid" style={{ maxWidth: 560 }}>
        <div className="field full">
          <PasswordField
            label={hasKey ? 'Replace API key' : 'API key'}
            name="assistant-api-key"
            autoComplete="off"
            value={keyInput}
            onChange={(v) => {
              setKeyInput(v);
              setJustSaved(false);
              setKeyError(null);
            }}
            error={keyError ?? undefined}
          />
        </div>
      </div>

      {hasKey && (
        <p className="set-note" role="status" style={{ marginTop: 14 }}>
          A key is saved — the assistant runs against your own provider. Enter a new key above to
          replace it, or remove it to switch the assistant {hosted ? 'back to your plan' : 'off'}.
        </p>
      )}

      <p className="desc" style={{ marginTop: 14, marginBottom: 0 }}>
        Keys are stored encrypted and used only for your requests. Remove the key any time to switch
        back {hosted ? 'to your plan' : 'off'} or turn the assistant off.
      </p>

      <div className="pd-actions" style={{ marginTop: 18 }}>
        <button
          type="button"
          className="btn primary sm"
          disabled={trimmedKey.length === 0 || saving}
          onClick={() => void persistKey(trimmedKey)}
        >
          {saving ? 'Saving…' : hasKey ? 'Replace key' : 'Save key'}
        </button>
        {hasKey && (
          <button
            type="button"
            className="btn ghost sm"
            disabled={saving}
            onClick={() => void persistKey(null)}
          >
            Remove key
          </button>
        )}
        {justSaved && <span className="field-hint">Saved.</span>}
      </div>
    </div>
  );
}
