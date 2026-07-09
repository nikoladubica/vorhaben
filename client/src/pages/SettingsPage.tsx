// Settings: a left-nav + body layout matching the design file's `.set-grid`. The active section
// is purely local state (no routing). Only the three in-scope sections are wired — Account,
// Currency & rates, and Tags; the design's Assistant/Data/Hosting sections are out of scope.

import { useState } from 'react';
import { AccountSection } from '../components/settings/AccountSection';
import { FxRatesSection } from '../components/settings/FxRatesSection';
import { TagsSection } from '../components/settings/TagsSection';
import { DataSection } from '../components/settings/DataSection';

type SectionId = 'account' | 'currency' | 'tags' | 'data';

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'account', label: 'Account' },
  { id: 'currency', label: 'Currency & rates' },
  { id: 'tags', label: 'Tags' },
  { id: 'data', label: 'Data' },
];

export function SettingsPage() {
  const [active, setActive] = useState<SectionId>('account');

  return (
    <div>
      <div className="dash-head">
        <h3>Settings</h3>
      </div>

      <div className="set-grid">
        <nav className="set-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={active === s.id ? 'on' : undefined}
              aria-current={active === s.id ? 'page' : undefined}
              onClick={() => setActive(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <div className="set-body">
          {active === 'account' && <AccountSection />}
          {active === 'currency' && <FxRatesSection />}
          {active === 'tags' && <TagsSection />}
          {active === 'data' && <DataSection />}
        </div>
      </div>
    </div>
  );
}
