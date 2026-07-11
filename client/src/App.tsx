import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './auth/RequireAuth';
import { useAuth } from './auth/useAuth';
import { AppLayout } from './layout/AppLayout';
import { LandingPage } from './pages/LandingPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { ClosePage } from './pages/ClosePage';
import { StatementPage } from './pages/StatementPage';
import { DashboardPage } from './pages/DashboardPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { ProjectFormPage } from './pages/ProjectFormPage';
import { ProjectDetailPage } from './pages/ProjectDetailPage';
import { EndingRitualPage } from './pages/EndingRitualPage';
import { SettingsPage } from './pages/SettingsPage';
import { NotesPage } from './pages/NotesPage';
import { IncomePage } from './pages/IncomePage';
import { Canvas } from './pages/Canvas';
import { MatrixPage } from './pages/MatrixPage';
import { Capture } from './pages/Capture';
import { ScanInvoicePage } from './pages/ScanInvoicePage';
import { TryCanvasPage } from './pages/TryCanvasPage';
import { PricingPage } from './pages/PricingPage';
import './App.css';

/** Root gate: visitors see the public landing page, signed-in users the app. */
function HomeGate() {
  const auth = useAuth();

  if (auth.status === 'loading') {
    return <div className="app-boot" aria-hidden="true" />;
  }
  if (auth.status === 'anonymous') {
    return <LandingPage />;
  }
  return <AppLayout />;
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/try-canvas" element={<TryCanvasPage />} />
      <Route path="/pricing" element={<PricingPage />} />

      {/* The Honesty Contract (ticket 03). Its own full-page surface — authenticated but outside
          AppLayout, so it never nests inside the app chrome or the onboarding gate. */}
      <Route
        path="/welcome"
        element={
          <RequireAuth>
            <OnboardingPage />
          </RequireAuth>
        }
      />

      {/* The Weekly Close (ticket 04). Its own full-page ritual surface — authenticated but outside
          AppLayout, so the calm walk is set apart from the app chrome, like the Honesty Contract. */}
      <Route
        path="/close"
        element={
          <RequireAuth>
            <ClosePage />
          </RequireAuth>
        }
      />

      {/* The ending ritual (ticket 06 / §2.7). Its own full-page statement surface — authenticated
          but outside AppLayout, so the closing screen is set apart from the app chrome, like the
          Weekly Close and the Honesty Contract. */}
      <Route
        path="/projects/:id/end"
        element={
          <RequireAuth>
            <EndingRitualPage />
          </RequireAuth>
        }
      />

      {/* The Quarterly Statement (ticket 07 / §2.8). Its own print-quality surface — authenticated but
          outside AppLayout, so it carries its own chrome (which vanishes under @media print) and the
          page prints as a clean A4, like the Weekly Close and the ending ritual sit apart. */}
      <Route
        path="/statement/:period"
        element={
          <RequireAuth>
            <StatementPage />
          </RequireAuth>
        }
      />

      <Route element={<HomeGate />}>
        <Route path="/" element={<DashboardPage />} />
      </Route>

      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/new" element={<ProjectFormPage />} />
        <Route path="/projects/scan" element={<ScanInvoicePage />} />
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
        <Route path="/projects/:id/edit" element={<ProjectFormPage />} />
        <Route path="/notes" element={<NotesPage />} />
        <Route path="/income" element={<IncomePage />} />
        <Route path="/canvas" element={<Canvas />} />
        <Route path="/matrix" element={<MatrixPage />} />
        <Route path="/capture" element={<Capture />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
