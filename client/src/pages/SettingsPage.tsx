// Settings: a left-nav + body layout matching the design file's `.set-grid`. The active section
// is purely local state (no routing). Wired sections: Account, Currency & rates, Weekly Close,
// Tags, Data — plus Assistant, shown ONLY when the instance has a platform LLM key
// (GET /api/voice/capabilities → llm:true). A self-host instance with no key sees no Assistant
// nav entry and no meter — no dead UI (ticket 12).

import { useEffect, useState } from 'react';
import { AccountSection } from '../components/settings/AccountSection';
import { FxRatesSection } from '../components/settings/FxRatesSection';
import { TagsSection } from '../components/settings/TagsSection';
import { DataSection } from '../components/settings/DataSection';
import { CloseSettingsSection } from '../components/settings/CloseSettingsSection';
import { AssistantSection } from '../components/settings/AssistantSection';
import { getCapabilities } from '../api/capture';

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
  // null while we probe; the Assistant section/nav appears only when a platform key is configured.
  const [assistantEnabled, setAssistantEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    getCapabilities()
      .then((c) => {
        if (!cancelled) setAssistantEnabled(c.llm);
      })
      .catch(() => {
        if (!cancelled) setAssistantEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sections = SECTIONS.filter((s) => s.id !== 'assistant' || assistantEnabled === true);

  return (
    <div>
      <div className="dash-head">
        <h3>Settings</h3>
      </div>

      <div className="set-grid">
        <nav className="set-nav" aria-label="Settings sections">
          {sections.map((s) => (
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
          {active === 'assistant' && assistantEnabled === true && <AssistantSection />}
          {active === 'tags' && <TagsSection />}
          {active === 'data' && <DataSection />}
        </div>
      </div>
    </div>
  );
}
