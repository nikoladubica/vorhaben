import { useState } from 'react';
import { Link } from 'react-router-dom';
import './landing.css';

/* Sparkline of effective hourly rate — same placeholder series as the design mock. */
const SPARK = [31, 33, 32, 35, 34, 36, 38, 37, 39, 40, 40, 41];
const SW = 320;
const SH = 56;
const SPAD = 6;
const SMIN = 28;
const SMAX = 44;
const sx = (i: number) => SPAD + (i / (SPARK.length - 1)) * (SW - SPAD * 2);
const sy = (v: number) => SPAD + (1 - (v - SMIN) / (SMAX - SMIN)) * (SH - SPAD * 2);
const sparkLine = SPARK.map((v, i) => `${i ? 'L' : 'M'}${sx(i)},${sy(v)}`).join(' ');
const sparkArea = `${sparkLine} L${sx(SPARK.length - 1)},${SH - 2} L${sx(0)},${SH - 2} Z`;

export function LandingPage() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="ld">
      <header className="ld-top">
        <span className="wordmark">
          <span className="sq" aria-hidden="true"></span>VORHABEN
        </span>
        <nav className="ld-nav" aria-label="Landing sections">
          <a href="#how-it-works">How it works</a>
          <a href="#voice">Voice capture</a>
          <a href="#open-source">Open source</a>
        </nav>
        <div className="ld-top-actions">
          <Link className="ld-signin" to="/login">
            Sign in
          </Link>
          <Link className="ld-top-cta" to="/register">
            Start free
          </Link>
        </div>
        <button
          className="ld-burger"
          type="button"
          aria-label="Menu"
          aria-expanded={menuOpen}
          aria-controls="ld-menu"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <i />
          <i />
          <i />
        </button>
        {menuOpen && (
          <div className="ld-menu" id="ld-menu">
            <a href="#how-it-works" onClick={() => setMenuOpen(false)}>
              How it works
            </a>
            <a href="#voice" onClick={() => setMenuOpen(false)}>
              Voice capture
            </a>
            <a href="#open-source" onClick={() => setMenuOpen(false)}>
              Open source
            </a>
            <Link to="/login">Sign in</Link>
            <Link className="ld-menu-cta" to="/register">
              Start free
            </Link>
          </div>
        )}
      </header>

      <main>
        {/* ————— hero ————— */}
        <section className="ld-hero">
          <div className="ld-hero-copy">
            <span className="ld-eyebrow">Project income tracker</span>
            <h1>
              Know which work <em>pays.</em>
            </h1>
            <p>
              Track every job, gig, contract and product in one place — and see which one gives you
              the most for your time.
            </p>
            <div className="ld-cta-row">
              <Link className="cta ld-cta" to="/register">
                Start tracking — free
              </Link>
              <Link className="ld-cta-2" to="/try-canvas">
                Play around with our canvas tool →
              </Link>
              <a className="ld-cta-sub" href="#open-source">
                Open source — <u>or self-host it</u>
              </a>
            </div>
          </div>

          <div className="ld-proof" aria-label="Example insight">
            <div className="ld-proof-row1">
              <span className="ld-lbl">Your effective rate</span>
              <span className="ld-lbl num">June</span>
            </div>
            <div className="ld-proof-amt num">CHF 41/h</div>
            <div className="ld-proof-cmp num">
              Best project: Studio K at <b>CHF 62/h</b> — 2.4× your salaried rate
            </div>
            <figure className="ld-proof-chart">
              <svg
                viewBox={`0 0 ${SW} ${SH}`}
                width="100%"
                role="img"
                aria-label="Sparkline of effective hourly rate over 12 months, trending upward"
              >
                <path d={sparkArea} fill="rgba(169,167,161,0.14)" stroke="none" />
                <path
                  d={sparkLine}
                  fill="none"
                  stroke="#a9a7a1"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <circle
                  cx={sx(SPARK.length - 1)}
                  cy={sy(SPARK[SPARK.length - 1])}
                  r="4.5"
                  fill="#da291c"
                  stroke="#ffffff"
                  strokeWidth="2"
                />
              </svg>
            </figure>
          </div>
        </section>

        {/* ————— the three pillars ————— */}
        <section className="ld-feats" aria-label="What Vorhaben does">
          <div className="ld-feat">
            <span className="ld-no num">1</span>
            <div>
              <h4>Every income type</h4>
              <p>
                Salary, hourly, commission, margin, dividends, one-off — normalised so they compare
                honestly.
              </p>
            </div>
          </div>
          <div className="ld-feat">
            <span className="ld-no num">2</span>
            <div>
              <h4>One number that matters</h4>
              <p>
                Your effective hourly rate, per project. The dashboard tells you where your time is
                best spent.
              </p>
            </div>
          </div>
          <div className="ld-feat">
            <span className="ld-no num">3</span>
            <div>
              <h4>Notes that keep up</h4>
              <p>Markdown notes on every project — a journal of what worked and what didn’t.</p>
            </div>
          </div>
        </section>

        {/* ————— voice capture ————— */}
        <section className="ld-voice" id="voice">
          <div className="ld-voice-copy">
            <span className="ld-eyebrow">Voice capture</span>
            <h2>Say it — and it’s on the list.</h2>
            <p>
              Walking out of a client meeting with five things in your head? Tap the mic and talk.
              Vorhaben turns your words into a checklist, a note, a reminder or an event — filed on
              the right project.
            </p>
            <ul className="ld-voice-points">
              <li>
                <b>Private by design.</b> Speech is transcribed in your browser — audio never leaves
                your device.
              </li>
              <li>
                <b>No AI service required.</b> A built-in parser structures your words on any
                install; an AI key only makes it sharper.
              </li>
              <li>
                <b>You confirm everything.</b> Every capture is shown as an editable draft before
                it’s saved. Nothing lands unreviewed.
              </li>
              <li>
                <b>“Remind me Friday” just works.</b> Dates in your speech become dated reminders
                you can tick off or dismiss.
              </li>
            </ul>
          </div>

          <div className="ld-voice-demo" aria-label="Voice capture example">
            <div className="ld-transcript">
              <span className="ld-lbl">You said</span>
              <p>
                “Checklist for Kiosk SaaS — fix the Stripe webhook, email the two trial users, and
                draft the changelog. Remind me Friday to check churn.”
              </p>
            </div>
            <div className="ld-parsed">
              <div className="ld-parsed-h">
                <span className="ld-lbl">Saved to Kiosk SaaS</span>
                <span className="ld-kind">Checklist</span>
              </div>
              <ul className="ld-checklist">
                <li className="done">
                  <span className="ld-check checked" aria-hidden="true"></span>
                  Fix the Stripe webhook
                </li>
                <li>
                  <span className="ld-check" aria-hidden="true"></span>
                  Email the two trial users
                </li>
                <li>
                  <span className="ld-check" aria-hidden="true"></span>
                  Draft the changelog
                </li>
              </ul>
              <div className="ld-reminder num">
                <span className="ld-lbl">Reminder</span>
                <span>
                  Check churn — <b>Fri 10.07.</b>
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* ————— how it works ————— */}
        <section className="ld-guide" id="how-it-works">
          <div className="ld-guide-head">
            <span className="ld-eyebrow">How it works</span>
            <h2>Your personal projects, managed like a business.</h2>
            <p>
              A side project that “feels productive” and a gig that quietly pays double look the
              same in your head. Vorhaben makes the difference visible — in three habits that take
              minutes a week.
            </p>
          </div>
          <div className="ld-steps">
            <div className="ld-step">
              <span className="ld-step-no num">01</span>
              <h4>Add every undertaking</h4>
              <p>
                Your job, freelance clients, one-off gigs, the SaaS, the resale hustle — each
                becomes a project with its own compensation model, from monthly salary to
                commission. Ended projects stay on the timeline; history is the point.
              </p>
            </div>
            <div className="ld-step">
              <span className="ld-step-no num">02</span>
              <h4>Log income, roughly track time</h4>
              <p>
                Logging an entry takes under ten seconds, in any currency. Hours can be a rough
                weekly estimate — enough to unlock your effective hourly rate without turning life
                into a timesheet.
              </p>
            </div>
            <div className="ld-step">
              <span className="ld-step-no num">03</span>
              <h4>Let the dashboard decide</h4>
              <p>
                Everything is normalised to monthly equivalents in your base currency, then ranked.
                One focus line tells you which project deserves more of your week — and which one is
                costing you.
              </p>
            </div>
          </div>
        </section>

        {/* ————— open source ————— */}
        <section className="ld-oss" id="open-source">
          <div>
            <span className="ld-eyebrow">Open source</span>
            <h2>Your numbers, your server — if you want.</h2>
          </div>
          <div className="ld-oss-body">
            <p>
              <b>Open source, MIT.</b> Run it on your own server, or let us host it for you — same
              app, no locked features. Tracking, dashboard, notes and voice capture work the same
              everywhere; the hosted tier only adds convenience, never a paywall on your data.
            </p>
            <p className="ld-disc">
              Vorhaben is not a wallet or a portfolio. It holds no funds and connects to no accounts
              — it simply shows you what your work is worth.
            </p>
          </div>
        </section>

        {/* ————— closing ————— */}
        <section className="ld-close">
          <h2>
            Know which work <em>pays.</em>
          </h2>
          <div className="ld-cta-row">
            <Link className="cta ld-cta" to="/register">
              Start tracking — free
            </Link>
            <Link className="ld-cta-sub" to="/login">
              Already tracking? <u>Sign in</u>
            </Link>
          </div>
        </section>
      </main>

      <footer className="ld-foot">
        <span className="wordmark">
          <span className="sq" aria-hidden="true"></span>VORHABEN
        </span>
        <span className="ld-foot-note">Vorhaben — German for “undertaking”. MIT licensed.</span>
      </footer>
    </div>
  );
}
