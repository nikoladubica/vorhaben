// Account settings: read-only email plus the base-currency chooser. Changing the base currency
// re-denominates every converted figure, so we warn that stored fx rates are per base currency
// before saving. On success the confirmed user is pushed back into the auth session.

import { useMemo, useState } from 'react';
import { ApiError } from '../../api';
import { updateBaseCurrency } from '../../api/account';
import { useAuth } from '../../auth/useAuth';
import { CURRENCIES } from '../../domain/currencies';

const OTHER = '__other__';

export function AccountSection() {
  const auth = useAuth();
  const user = auth.status === 'user' ? auth.user : null;
  const saved = user?.base_currency ?? '';

  // Whether the saved currency is one of the presets decides the initial select value.
  const savedIsPreset = useMemo(() => CURRENCIES.some((c) => c.value === saved), [saved]);

  const [choice, setChoice] = useState<string>(savedIsPreset ? saved : OTHER);
  const [otherCode, setOtherCode] = useState<string>(savedIsPreset ? '' : saved);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  // The currency the form currently represents, normalized to 3-letter uppercase.
  const selected = (choice === OTHER ? otherCode : choice).toUpperCase();
  const dirty = selected !== saved;
  const canSave = dirty && selected.length === 3 && !pending;

  async function onSave() {
    setError(null);
    setJustSaved(false);
    setPending(true);
    try {
      const updated = await updateBaseCurrency(selected);
      auth.updateUser(updated);
      setJustSaved(true);
    } catch (err) {
      if (err instanceof ApiError && err.error === 'invalid_base_currency') {
        setError('That is not a valid 3-letter currency code.');
      } else {
        setError('Could not save your base currency. Please try again.');
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="set-sec">
      <h4>Account</h4>
      <p className="desc">
        Your sign-in email and the base currency every figure is normalized to. Changing the base
        currency re-denominates your dashboard and comparisons.
      </p>

      <div className="fgrid" style={{ maxWidth: 560 }}>
        <label className="field full">
          <span>Email</span>
          <input type="email" value={user?.email ?? ''} readOnly disabled />
        </label>

        <label className="field">
          <span>Base currency</span>
          <select
            value={choice}
            onChange={(e) => {
              setChoice(e.target.value);
              setJustSaved(false);
              setError(null);
            }}
          >
            {CURRENCIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
            <option value={OTHER}>Other…</option>
          </select>
        </label>

        {choice === OTHER && (
          <label className="field">
            <span>Currency code</span>
            <input
              type="text"
              value={otherCode}
              maxLength={3}
              placeholder="e.g. NOK"
              autoCapitalize="characters"
              onChange={(e) => {
                setOtherCode(e.target.value.toUpperCase());
                setJustSaved(false);
                setError(null);
              }}
              aria-invalid={error ? true : undefined}
            />
          </label>
        )}
      </div>

      {dirty && (
        <p className="set-note" role="status" style={{ marginTop: 18 }}>
          Exchange rates are per base currency — you may need to re-enter rates.
        </p>
      )}

      {error && (
        <p className="form-error" role="alert" style={{ marginTop: 12 }}>
          {error}
        </p>
      )}

      <div className="pd-actions" style={{ marginTop: 18 }}>
        <button type="button" className="btn primary sm" disabled={!canSave} onClick={onSave}>
          {pending ? 'Saving…' : 'Save base currency'}
        </button>
        {justSaved && !dirty && <span className="field-hint">Saved.</span>}
      </div>
    </div>
  );
}
