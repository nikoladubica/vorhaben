import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { ApiError } from '../api';
import { useAuth } from '../auth/useAuth';
import { authErrorMessage } from '../auth/authErrors';

const CURRENCIES = ['EUR', 'CHF', 'USD', 'GBP'];

export function RegisterPage() {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [baseCurrency, setBaseCurrency] = useState('EUR');
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);

  if (auth.status === 'user') {
    return <Navigate to="/" replace />;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setFieldErrors({});
    setPending(true);
    try {
      await auth.register(email, password, baseCurrency);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.fields) {
          setFieldErrors(err.fields);
        } else {
          setFormError(authErrorMessage(err.error));
        }
      } else {
        setFormError('Something went wrong. Please try again.');
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="auth-stage">
      <form className="auth-card" onSubmit={onSubmit} noValidate>
        <span className="wordmark">
          <span className="sq" aria-hidden="true"></span>VORHABEN
        </span>
        <h4>Create your account</h4>

        {formError && (
          <p className="form-error" role="alert">
            {formError}
          </p>
        )}

        <label className="field">
          <span>Email</span>
          <input
            type="email"
            name="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={fieldErrors.email ? true : undefined}
          />
          {fieldErrors.email && <em className="field-error">{fieldErrors.email}</em>}
        </label>

        <label className="field">
          <span>Password</span>
          <input
            type="password"
            name="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={fieldErrors.password ? true : undefined}
          />
          {fieldErrors.password && <em className="field-error">{fieldErrors.password}</em>}
        </label>

        <label className="field">
          <span>Base currency</span>
          <select
            name="base_currency"
            value={baseCurrency}
            onChange={(e) => setBaseCurrency(e.target.value)}
            aria-invalid={fieldErrors.base_currency ? true : undefined}
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          {fieldErrors.base_currency && (
            <em className="field-error">{fieldErrors.base_currency}</em>
          )}
        </label>

        <button className="cta" type="submit" disabled={pending} style={{ marginTop: 8 }}>
          {pending ? 'Creating account…' : 'Create account'}
        </button>

        <p className="auth-alt">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </div>
  );
}
