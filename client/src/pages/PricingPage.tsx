import { useState } from 'react';
import { Link } from 'react-router-dom';
import './landing.css';

const REPO_URL = 'https://github.com/nikoladubica/vorhaben';

type Billing = 'monthly' | 'annual';

/** Public marketing pricing page (design screen 08), extended to three plans. */
export function PricingPage() {
  const [billing, setBilling] = useState<Billing>('monthly');
  const annual = billing === 'annual';

  return (
    <div className="ld">
      <header className="ld-top">
        <Link className="wordmark" to="/">
          <span className="sq" aria-hidden="true"></span>VORHABEN
        </Link>
        <nav className="ld-nav" aria-label="Pricing sections">
          <Link to="/">Home</Link>
        </nav>
        <div className="ld-top-actions">
          <Link className="ld-signin" to="/login">
            Sign in
          </Link>
        </div>
      </header>

      <main>
        <section className="price-page">
          <div className="price-intro">
            <span className="ld-eyebrow">Pricing</span>
            <h3>Same app, three ways to run it.</h3>
            <p>
              Vorhaben is open source under MIT. Nothing in the self-hosted version is locked,
              throttled or watermarked — the hosted plans pay for us running it, not for features
              held hostage.
            </p>
          </div>

          <div className="price-toggle" role="group" aria-label="Billing period">
            <button type="button" aria-pressed={!annual} onClick={() => setBilling('monthly')}>
              Monthly
            </button>
            <button type="button" aria-pressed={annual} onClick={() => setBilling('annual')}>
              Annual
            </button>
          </div>

          <div className="price-grid price-grid-3">
            {/* Self-hosted */}
            <div className="price-col">
              <span className="p-name">Self-hosted</span>
              <div className="p-amt num">
                $0 <small>forever</small>
              </div>
              <p className="p-save num" aria-hidden="true"></p>
              <p className="p-sub">Your server, your data, your rules.</p>
              <ul className="p-feats">
                <li>
                  <b>Everything.</b> Tracking, dashboard, notes, timeline — the full app
                </li>
                <li>MIT licensed, no telemetry, no account with us</li>
                <li>CSV import &amp; export</li>
                <li>AI assistant with your own API key</li>
                <li>One docker compose up to run</li>
              </ul>
              <a className="btn ghost" href={REPO_URL} target="_blank" rel="noreferrer">
                View on GitHub
              </a>
            </div>

            {/* Pro — highlighted, carries the page's single red element (the primary CTA) */}
            <div className="price-col hosted">
              <span className="p-name">Pro</span>
              <div className="p-amt num">
                {annual ? '$90' : '$9'} <small>{annual ? '/ year' : '/ month'}</small>
              </div>
              <p className="p-save num" aria-hidden={!annual}>
                {annual ? 'Save $18 a year' : ''}
              </p>
              <p className="p-sub">We run it, back it up, and keep it updated.</p>
              <ul className="p-feats">
                <li>
                  <b>Everything in self-hosted</b> — feature parity is the promise
                </li>
                <li>Managed backups, updates and uptime</li>
                <li>Assistant included, fair use</li>
                <li>Access from every device, zero setup</li>
                <li>Cancel any time; export takes your data with you</li>
              </ul>
              <Link className="btn primary" to="/register">
                Start free — 30 days
              </Link>
            </div>

            {/* Max — Pro plus the invoice scanner */}
            <div className="price-col">
              <span className="p-name">Max</span>
              <div className="p-amt num">
                {annual ? '$150' : '$15'} <small>{annual ? '/ year' : '/ month'}</small>
              </div>
              <p className="p-save num" aria-hidden={!annual}>
                {annual ? 'Save $30 a year' : ''}
              </p>
              <p className="p-sub">For people who’d rather not type invoices.</p>
              <ul className="p-feats">
                <li>
                  <b>Everything in Pro</b>
                </li>
                <li>Invoice scanner — upload a PDF, get income entries</li>
                <li>Projects created for you from your documents</li>
                <li>100 scans / month (fair use)</li>
              </ul>
              <Link className="btn ghost" to="/register">
                Start free — 30 days
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="ld-foot">
        <Link className="wordmark" to="/">
          <span className="sq" aria-hidden="true"></span>VORHABEN
        </Link>
        <span className="ld-foot-note">Vorhaben — German for “undertaking”. MIT licensed.</span>
      </footer>
    </div>
  );
}
