import { Navigate } from 'react-router-dom';
import { useAuth } from './useAuth';

/** Gate for the authenticated app. Renders children only for a signed-in user. */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const auth = useAuth();

  if (auth.status === 'loading') {
    // Session not resolved yet — render nothing to avoid a flash of the guard.
    return <div className="app-boot" aria-hidden="true" />;
  }
  if (auth.status === 'anonymous') {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
