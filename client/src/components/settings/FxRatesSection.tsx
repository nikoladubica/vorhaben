// Currency & rates: the table of stored exchange rates plus an inline add/edit row. Each rate is
// read explicitly as "1 {CUR} = {rate} {BASE}" so a value can never be inverted silently. Rates
// are keyed by (currency, as_of); re-adding the same pair upserts. Deleting asks first.

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../api';
import { type FxRate, deleteRate, listRates, upsertRate } from '../../api/fxRates';
import { useAuth } from '../../auth/useAuth';
import { todayString } from '../../domain/format';

function fieldMessage(code: string): string {
  switch (code) {
    case 'required':
      return 'Required.';
    case 'same_as_base':
      return 'Cannot set a rate for your base currency.';
    case 'invalid':
    default:
      return 'Not valid.';
  }
}

export function FxRatesSection() {
  const auth = useAuth();
  const base = auth.status === 'user' ? auth.user.base_currency : '';

  const [rates, setRates] = useState<FxRate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [currency, setCurrency] = useState('');
  const [rate, setRate] = useState('');
  const [asOf, setAsOf] = useState('');
  const [pending, setPending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    listRates()
      .then(setRates)
      .catch(() => setLoadError('Could not load exchange rates.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(refresh, [refresh]);

  async function onAdd() {
    setFieldErrors({});
    setFormError(null);
    setPending(true);
    try {
      await upsertRate({
        currency: currency.trim().toUpperCase(),
        rate: rate.trim(),
        as_of: asOf === '' ? undefined : asOf,
      });
      setCurrency('');
      setRate('');
      setAsOf('');
      refresh();
    } catch (err) {
      if (err instanceof ApiError && err.fields) {
        setFieldErrors(err.fields);
      } else {
        setFormError('Could not save the rate. Please try again.');
      }
    } finally {
      setPending(false);
    }
  }

  async function onDelete(row: FxRate) {
    const ok = window.confirm(
      `Remove the rate 1 ${row.currency} = ${row.rate} ${row.base_currency} as of ${row.as_of}?`,
    );
    if (!ok) return;
    try {
      await deleteRate(row.currency, row.as_of);
      refresh();
    } catch {
      setFormError('Could not remove the rate. Please try again.');
    }
  }

  return (
    <div className="set-sec" id="fx-rates">
      <h4>Currency &amp; rates</h4>
      <p className="desc">
        Exchange rates convert income in other currencies into {base || 'your base currency'} for
        the dashboard and comparisons. Each rate reads as “1 unit = {base || 'BASE'}”. The most
        recent rate on or before an entry’s date is used.
      </p>

      {formError && (
        <p className="form-error" role="alert">
          {formError}
        </p>
      )}

      <div className="table-scroll">
        <table className="projects fx-table">
          <thead>
            <tr>
              <th>Currency</th>
              <th className="r">Rate</th>
              <th>As of</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={4}>Loading…</td>
              </tr>
            ) : loadError ? (
              <tr>
                <td colSpan={4}>{loadError}</td>
              </tr>
            ) : rates.length === 0 ? (
              <tr>
                <td colSpan={4} className="fx-empty">
                  No rates yet. Add one below.
                </td>
              </tr>
            ) : (
              rates.map((row) => (
                <tr key={`${row.currency}-${row.as_of}`}>
                  <td>{row.currency}</td>
                  <td className="r">
                    {row.rate}
                    <span className="fx-caption num">
                      1 {row.currency} = {row.rate} {row.base_currency}
                    </span>
                  </td>
                  <td className="num">{row.as_of}</td>
                  <td className="r">
                    <div className="row-actions">
                      <button
                        type="button"
                        className="row-btn danger"
                        onClick={() => onDelete(row)}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="entry-add fx-add">
        <input
          type="text"
          value={currency}
          maxLength={3}
          placeholder="EUR"
          aria-label="Currency"
          aria-invalid={fieldErrors.currency ? true : undefined}
          onChange={(e) => setCurrency(e.target.value.toUpperCase())}
        />
        <input
          type="text"
          inputMode="decimal"
          value={rate}
          placeholder={`Rate to ${base || 'base'}`}
          aria-label="Rate"
          aria-invalid={fieldErrors.rate ? true : undefined}
          onChange={(e) => setRate(e.target.value)}
        />
        <input
          type="date"
          value={asOf}
          max={todayString()}
          aria-label="As of date (defaults to today)"
          onChange={(e) => setAsOf(e.target.value)}
        />
        <button
          type="button"
          className="btn primary sm"
          disabled={pending || currency.trim() === '' || rate.trim() === ''}
          onClick={onAdd}
        >
          {pending ? 'Saving…' : 'Save rate'}
        </button>
      </div>

      {(fieldErrors.currency || fieldErrors.rate) && (
        <p className="field-error quick-add-error" role="alert">
          {fieldErrors.currency
            ? `Currency: ${fieldMessage(fieldErrors.currency)}`
            : `Rate: ${fieldMessage(fieldErrors.rate)}`}
        </p>
      )}

      <p className="field-hint">
        Leave the date blank to record today’s rate. Rates read as “1 {currency || 'CUR'} ={' '}
        {rate || '…'} {base || 'BASE'}”.
      </p>
    </div>
  );
}
