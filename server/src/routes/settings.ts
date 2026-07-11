import { Router } from 'express';
import { db } from '../db/index.js';
import { encryptSecret } from '../crypto/secretBox.js';

// Mounted at /api/settings behind requireAuth (see app.ts). Owns the Assistant settings screen's
// read/write (ticket 13): the caller's hosted plan (read-only here — billing is a separate ticket)
// and their optional bring-your-own assistant API key. The id always comes from the auth token
// (req.userId), never the body.
export const settingsRouter = Router();

// A stored provider key should comfortably fit; anything longer is a paste error, not a key.
const MAX_KEY_LEN = 512;

// Only plans we know how to price on the client. Anything else (or null) reads as "no plan".
type Plan = 'monthly' | 'yearly';
function normalizePlan(value: unknown): Plan | null {
  return value === 'monthly' || value === 'yearly' ? value : null;
}

interface AssistantRow {
  id: number;
  plan: string | null;
  plan_renews_at: Date | string | null;
  assistant_api_key_encrypted: string | null;
}

// The public assistant-settings shape. NEVER carries the key — only whether one is set. `renews_at`
// is an ISO instant or null; `plan` is a known plan id or null (→ the client shows the upgrade CTA).
function publicAssistant(row: AssistantRow) {
  const renews = row.plan_renews_at;
  return {
    plan: normalizePlan(row.plan),
    renews_at: renews ? new Date(renews).toISOString() : null,
    has_key: row.assistant_api_key_encrypted != null,
  };
}

async function loadAssistant(userId: number): Promise<AssistantRow | undefined> {
  return db<AssistantRow>('users')
    .where({ id: userId })
    .first('plan', 'plan_renews_at', 'assistant_api_key_encrypted');
}

// GET /api/settings/assistant → { plan, renews_at, has_key }. Booleans/strings only — the encrypted
// key never leaves the server, and there is no field a plaintext key could hide in.
settingsRouter.get('/assistant', async (req, res) => {
  const userId = req.userId as number;
  const row = await loadAssistant(userId);
  if (!row) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  res.json(publicAssistant(row));
});

// PUT /api/settings/assistant — body { api_key }. A non-empty string is stored ENCRYPTED at rest;
// null or "" clears the key (switch the assistant back to the hosted plan / off). The plaintext is
// never logged and never echoed — the response is the same has_key shape as GET.
settingsRouter.put('/assistant', async (req, res) => {
  const userId = req.userId as number;
  const body = (req.body ?? {}) as { api_key?: unknown };
  const raw = body.api_key;

  let encrypted: string | null;
  if (raw == null || raw === '') {
    encrypted = null; // clear
  } else if (typeof raw === 'string') {
    const key = raw.trim();
    if (key.length === 0) {
      encrypted = null;
    } else if (key.length > MAX_KEY_LEN) {
      res.status(422).json({ error: 'validation', fields: { api_key: 'too_long' } });
      return;
    } else {
      encrypted = encryptSecret(key);
    }
  } else {
    res.status(422).json({ error: 'validation', fields: { api_key: 'invalid' } });
    return;
  }

  await db('users').where({ id: userId }).update({ assistant_api_key_encrypted: encrypted });

  const row = await loadAssistant(userId);
  if (!row) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  res.json(publicAssistant(row));
});
