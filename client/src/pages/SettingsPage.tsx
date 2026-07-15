// Settings: a left-nav + body layout matching the design file's `.set-grid`. The active section
// is purely local state (no routing). Wired sections: Account, Currency & rates, Weekly Close,
// Assistant, Tags, Data. The Assistant section is always present — hosted instances see their plan
// and usage meter (ticket 12), self-hosters see the bring-your-own-key form (ticket 13). It decides
// internally what to show from GET /api/voice/capabilities, so there is no dead UI either way.

import { useState } from 'react';
import { AccountSection } from '../components/settings/AccountSection';
import { FxRatesSection } from '../components/settings/FxRatesSection';
import { TagsSection } from '../components/settings/TagsSection';
import { DataSection } from '../components/settings/DataSection';
import { CloseSettingsSection } from '../components/settings/CloseSettingsSection';
import { AssistantSection } from '../components/settings/AssistantSection';

type SectionId = 'account' | 'currency' | 'weekly-close' | 'assistant' | 'tags' | 'data';

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'account', label: 'Account' },
  { id: 'currency', label: 'Currency & rates' },
  { id: 'weekly-close', label: 'Weekly Close' },
  { id: 'assistant', label: 'Assistant' },
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
          {active === 'weekly-close' && <CloseSettingsSection />}
          {active === 'assistant' && <AssistantSection />}
          {active === 'tags' && <TagsSection />}
          {active === 'data' && <DataSection />}
        </div>
      </div>
    </div>
  );
}
