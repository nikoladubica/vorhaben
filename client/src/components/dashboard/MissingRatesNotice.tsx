// A dismissible notice naming currency codes that had no usable fx rate, so converted figures for
// those entries fell back (or were skipped) on the server. Uses the design file's `.warn-flag`
// treatment (income screen). Dismissal is view-local — it reappears on the next load if the
// warning still applies, which is intentional: it is information, not an error to acknowledge away.

import { useState } from 'react';
import { Link } from 'react-router-dom';

interface MissingRatesNoticeProps {
  currencies: string[];
}

export function MissingRatesNotice({ currencies }: MissingRatesNoticeProps) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || currencies.length === 0) return null;

  const list = currencies.join(', ');
  return (
    <div className="rates-notice" role="status">
      <span className="warn-flag">Missing rates</span>
      <span className="rates-body">
        No exchange rate for {list} — amounts in{' '}
        {currencies.length > 1 ? 'these currencies' : 'this currency'} may be incomplete.{' '}
        <Link to="/settings">Add rates</Link>
      </span>
      <button
        type="button"
        className="undo-dismiss"
        aria-label="Dismiss missing-rates notice"
        onClick={() => setDismissed(true)}
      >
        ×
      </button>
    </div>
  );
}
