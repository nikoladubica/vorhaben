import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api, setOnUnauthorized } from '../api';
import { AuthContext, type AuthState, type User } from './auth-context';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  // Bootstrap: resolve the current session. A 401 here just means "anonymous";
  // it must NOT fire the global unauthorized handler (that would loop).
  useEffect(() => {
    let cancelled = false;
    api
      .get<User>('/auth/me', { silent401: true })
      .then((user) => {
        if (!cancelled) setState({ status: 'user', user });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          setState({ status: 'anonymous' });
        } else {
          // Network or unexpected error — treat as anonymous so the app is usable.
          setState({ status: 'anonymous' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A 401 from any in-app call drops us to anonymous; the route guard redirects.
  useEffect(() => {
    setOnUnauthorized(() => setState({ status: 'anonymous' }));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const user = await api.post<User>('/auth/login', { email, password });
    setState({ status: 'user', user });
  }, []);

  const register = useCallback(async (email: string, password: string, base_currency?: string) => {
    const body: Record<string, unknown> = { email, password };
    if (base_currency) body.base_currency = base_currency;
    const user = await api.post<User>('/auth/register', body);
    setState({ status: 'user', user });
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post<{ ok: true }>('/auth/logout');
    } finally {
      setState({ status: 'anonymous' });
    }
  }, []);

  const value = useMemo(
    () => ({ ...state, login, register, logout }),
    [state, login, register, logout],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}
