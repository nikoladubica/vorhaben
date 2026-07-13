// The Weekly Close banner (ticket 04 / §2.5) — one in-app line shown on the Dashboard and Projects
// pages from the user's close day until the week is closed. Paper-tint panel with a red top focus
// rule (ticket 19) — its one earned accent; otherwise square, no animation, no badge. Presentational:
// WeeklyRitual owns the decision to show it and passes the dismiss handler; the two banners never
// stack (the coordinator renders at most one). Missed weeks carry no guilt copy and no backlog —
// this is just this week.

import { Link } from 'react-router-dom';
import './close-banner.css';

interface CloseBannerProps {
  onDismiss: () => void;
}

export function CloseBanner({ onDismiss }: CloseBannerProps) {
  return (
    <section className="close-banner" aria-label="Weekly close">
      <span className="close-banner-text">Time to close the week.</span>
      <Link to="/close" className="close-banner-link">
        Start the close
      </Link>
      <button type="button" className="close-banner-x" aria-label="Not now" onClick={onDismiss}>
        ×
      </button>
    </section>
  );
}
