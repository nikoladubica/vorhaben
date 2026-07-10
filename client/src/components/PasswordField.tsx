import { useState } from 'react';

interface PasswordFieldProps {
  label?: string;
  name: string;
  autoComplete: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}

/** Password input with a show/hide toggle. Shared by the login and register forms. */
export function PasswordField({
  label = 'Password',
  name,
  autoComplete,
  value,
  onChange,
  error,
}: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);

  return (
    <label className="field">
      <span>{label}</span>
      <div className="password-wrap">
        <input
          type={visible ? 'text' : 'password'}
          name={name}
          autoComplete={autoComplete}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
        />
        <button
          type="button"
          className="password-toggle"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </div>
      {error && <em className="field-error">{error}</em>}
    </label>
  );
}

function EyeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M1.5 12S5 5 12 5s10.5 7 10.5 7-3.5 7-10.5 7S1.5 12 1.5 12Z"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M9.9 5.2A9.9 9.9 0 0 1 12 5c7 0 10.5 7 10.5 7a17 17 0 0 1-3 3.7M6 6.7A17 17 0 0 0 1.5 12S5 19 12 19a9.9 9.9 0 0 0 4-.8"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path d="m3 3 18 18" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
