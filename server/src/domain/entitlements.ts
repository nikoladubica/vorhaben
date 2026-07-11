// Feature entitlements (ticket 14). A tiny, isolated decision layer so the ONE place that decides
// "may this user use a paid feature" is not scattered through routes — and so the eventual billing
// integration (Stripe) has a single seam to plug into. Per BUSINESS_LOGIC.md §7 / CLAUDE.md, only
// LLM-assistant features may be gated; core tracking, dashboard and notes are never entitlement-
// checked.

// The subset of the users row this layer reads. `plan_tier` is the Max-tier entitlement column
// (migration 20260711143921); null for everyone until billing writes it.
export interface EntitlementUser {
  plan_tier?: string | null;
}

// The invoice scanner (Max tier, marketing-strategy §3.6). BYOK PARITY holds: a user calling with
// their own Anthropic key (self-hoster or hosted BYOK) gets the scanner regardless of plan — their
// key, their bill, no platform-key cost to gate. Otherwise the platform key is footing the bill, so
// the Max tier is required. `hasByok` is resolved by the caller (a usable, decrypted BYOK key), not
// read here, so this stays a pure function.
export function canUseInvoiceScanner(user: EntitlementUser, hasByok: boolean): boolean {
  if (hasByok) return true;
  return user.plan_tier === 'max';
}
