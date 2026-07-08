import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { ApiError } from '../api';
import { useAuth } from '../auth/useAuth';
import { authErrorMessage } from '../auth/authErrors';

export function LoginPage() {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
      await auth.login(email, password);
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
        <h4>Sign in</h4>

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
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={fieldErrors.password ? true : undefined}
          />
          {fieldErrors.password && <em className="field-error">{fieldErrors.password}</em>}
        </label>

        <button className="cta" type="submit" disabled={pending} style={{ marginTop: 8 }}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="auth-alt">
          New here? <Link to="/register">Create an account</Link>
        </p>
      </form>
    </div>
  );
}
