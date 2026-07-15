// Assistant settings calls built on the shared `api` helper (ticket 13). The server NEVER returns
// the stored API key — only `has_key` — so there is nothing sensitive to hold client-side.

import { api } from '../api';

export type AssistantPlan = 'monthly' | 'yearly';

// GET/PUT /api/settings/assistant shape. `plan` is null for a user with no paid plan (→ upgrade
// CTA); `renews_at` is an ISO instant or null; `has_key` is whether a self-hoster BYOK key is set.
export interface AssistantSettings {
  plan: AssistantPlan | null;
  renews_at: string | null;
  has_key: boolean;
}

export function getAssistantSettings(): Promise<AssistantSettings> {
  return api.get<AssistantSettings>('/settings/assistant');
}

// Save a bring-your-own key, or pass null / '' to clear it. Returns the updated (key-free) settings.
export function saveAssistantKey(apiKey: string | null): Promise<AssistantSettings> {
  return api.put<AssistantSettings>('/settings/assistant', { api_key: apiKey });
}
