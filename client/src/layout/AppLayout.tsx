import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';

function initials(email: string): string {
  const local = email.split('@')[0] ?? '';
  const parts = local.split(/[._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0][0] + parts[1][0] : local.slice(0, 2);
  return letters.toUpperCase() || '?';
}

export function AppLayout() {
  const auth = useAuth();
  const navigate = useNavigate();
  const email = auth.status === 'user' ? auth.user.email : '';

  async function onLogout() {
    await auth.logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="app-shell">
      <div className="topbar">
        <span className="wordmark">
          <span className="sq" aria-hidden="true"></span>VORHABEN
        </span>
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
          <NavLink to="/capture" className={({ isActive }) => (isActive ? 'on' : undefined)}>
            Capture
          </NavLink>
          {/* Income is owned by a later ticket; shown muted until routed. */}
          <span className="soon" aria-disabled="true">
            Income
          </span>
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

      <main className="page">
        <Outlet />
      </main>
    </div>
  );
}
