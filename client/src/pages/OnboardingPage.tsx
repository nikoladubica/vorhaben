// The Honesty Contract (ticket 03 / breakthrough §2.1). A fresh account with zero projects lands
// here before anything else: one calm sheet that states the deal — four things from the user, one
// thing back from us — then a single primary action. The copy IS the feature; no illustrations, no
// mascots. Screen spec by design-guardian-agent; tokens only, one earned red (the CTA).
//
// Completion is tracked per-user in localStorage (see ../onboarding). "Continue" hands off to the
// setup wizard (/welcome/setup), which marks completion only once it creates the projects; "Skip"
// marks it immediately. An already-onboarded user who reaches /welcome by URL is bounced home.

import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';
import { isOnboarded, markOnboarded } from '../onboarding';
import './onboarding.css';

// The four points, in order — a contract is genuinely ordered, hence an <ol>.
const POINTS: { title: string; body: string }[] = [
  {
    title: 'Add all of them.',
    body: 'The job, the clients, the side thing you feel a little guilty about. Leave nothing out — the point is the full picture, not the flattering one.',
  },
  {
    title: 'Be honest about the mood.',
    body: 'Set an honest mood, especially on the bad days. We analyse what you give us, and the analysis is only as truthful as you are.',
  },
  {
    title: 'Keep it up.',
    body: 'Set your mood every day, or change it the moment it actually changes — either works, and every change is kept. Consistency beats frequency.',
  },
  {
    title: 'In return, we make sense of it.',
    body: 'Swings, trends, and a first real read after about three days of moods — not someday. That’s our half of the deal.',
  },
];

export function OnboardingPage() {
  const auth = useAuth();
  const navigate = useNavigate();

  // RequireAuth guarantees a signed-in user; this satisfies the type narrowing.
  if (auth.status !== 'user') return null;
  const userId = auth.user.id;

  // Existing users (already onboarded, or arrived here by URL after finishing) never see the flow.
  if (isOnboarded(userId)) return <Navigate to="/" replace />;

  function start() {
    // Hand off to the setup wizard (design screen "03"). We do NOT mark onboarded here — completion
    // is only earned once the wizard actually creates the projects, so an abandoned run restarts.
    navigate('/welcome/setup');
  }

  function skip() {
    // A quiet exit is still completion — never trap the user, never show this again.
    markOnboarded(userId);
    navigate('/');
  }

  return (
    <main className="welcome-stage">
      <section className="contract" aria-labelledby="contract-title">
        <span className="wordmark">
          <span className="sq" aria-hidden="true"></span>VORHABEN
        </span>

        <p className="contract-kicker">The Honesty Contract</p>
        <h1 id="contract-title" className="contract-title">
          This only works if it’s honest.
        </h1>
        <p className="contract-lead">
          Vorhaben turns what you tell it into a clear picture of your work. So here’s the deal —
          four things from you, one thing back from us.
        </p>

        <ol className="contract-points">
          {POINTS.map((point, i) => (
            <li className="cpoint" key={point.title}>
              <span className="cnum num">{String(i + 1).padStart(2, '0')}</span>
              <div className="cpoint-body">
                <h2>{point.title}</h2>
                <p>{point.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="contract-actions">
          <button type="button" className="contract-cta" onClick={start}>
            Continue
          </button>
          <button type="button" className="contract-skip" onClick={skip}>
            Skip for now
          </button>
        </div>

        <p className="contract-note">
          Nothing here connects to a bank or wallet. Every figure is yours to enter — and to edit
          later.
        </p>
      </section>
    </main>
  );
}
