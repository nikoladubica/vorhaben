import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';
import { listProjects } from '../api/projects';
import { isOnboarded, markOnboarded } from '../onboarding';

function initials(email: string): string {
  const local = email.split('@')[0] ?? '';
  const parts = local.split(/[._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0][0] + parts[1][0] : local.slice(0, 2);
  return letters.toUpperCase() || '?';
}

// The onboarding gate (ticket 03). Every authenticated app page renders through AppLayout, so this
// is the single place a fresh account gets routed to the Honesty Contract. Once a user is onboarded
// (finished the flow, skipped it, or has ≥1 project) the check short-circuits with no network call.
type GateState = 'checking' | 'ok' | 'redirect';

function useOnboardingGate(userId: number | null): GateState {
  const [state, setState] = useState<GateState>('checking');

  useEffect(() => {
    if (userId === null) {
      // Not a signed-in user (RequireAuth/HomeGate handle that) — nothing to gate.
      setState('ok');
      return;
    }
    if (isOnboarded(userId)) {
      setState('ok');
      return;
    }
    // First authenticated load for this account: a user with projects has effectively onboarded
    // already, so we mark them and never check again; a truly empty account is sent to /welcome.
    let cancelled = false;
    setState('checking');
    listProjects()
      .then((rows) => {
        if (cancelled) return;
        if (rows.length > 0) {
          markOnboarded(userId);
          setState('ok');
        } else {
          setState('redirect');
        }
      })
      .catch(() => {
        // Never trap the user behind a failed check — let the app render.
        if (!cancelled) setState('ok');
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return state;
}

export function AppLayout() {
  const auth = useAuth();
  const navigate = useNavigate();
  const email = auth.status === 'user' ? auth.user.email : '';
  const userId = auth.status === 'user' ? auth.user.id : null;

  const gate = useOnboardingGate(userId);
  if (gate === 'checking') {
    // Resolve before painting so a fresh account never flashes the app then bounces to /welcome.
    return <div className="app-boot" aria-hidden="true" />;
  }
  if (gate === 'redirect') {
    return <Navigate to="/welcome" replace />;
  }

  async function onLogout() {
    await auth.logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="app-shell">
      <div className="topbar">
        <div className="topbar-inner">
          <Link className="wordmark" to="/">
            <span className="sq" aria-hidden="true"></span>VORHABEN
          </Link>
          <nav className="main" aria-label="Primary">
            <NavLink to="/" end className={({ isActive }) => (isActive ? 'on' : undefined)}>
              Dashboard
            </NavLink>
            <NavLink to="/projects" className={({ isActive }) => (isActive ? 'on' : undefined)}>
              Projects
            </NavLink>
            <NavLink to="/canvas" className={({ isActive }) => (isActive ? 'on' : undefined)}>
              Canvas
            </NavLink>
            <NavLink to="/matrix" className={({ isActive }) => (isActive ? 'on' : undefined)}>
              Matrix
            </NavLink>
            <NavLink to="/capture" className={({ isActive }) => (isActive ? 'on' : undefined)}>
              Capture
            </NavLink>
            <NavLink to="/income" className={({ isActive }) => (isActive ? 'on' : undefined)}>
              Income
            </NavLink>
            <NavLink to="/notes" className={({ isActive }) => (isActive ? 'on' : undefined)}>
              Notes
            </NavLink>
          </nav>

          <div className="account">
            <NavLink
              to="/settings"
              className="me"
              aria-label={`Account settings for ${email}`}
              title={email}
            >
              {initials(email)}
            </NavLink>
            <button type="button" className="logout" onClick={onLogout}>
              Sign out
            </button>
          </div>
        </div>
      </div>

      <main className="page">
        <Outlet />
      </main>
    </div>
  );
}
