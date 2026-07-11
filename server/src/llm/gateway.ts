// The LLM gateway — the SINGLE choke point every server-side Anthropic call goes through
// (ticket 12; marketing-strategy §3.5). Voice capture is the first consumer; chat and digests plug
// in later against this same module. Nothing else in the server should construct an Anthropic
// client or call client.messages.create directly.
//
// What it does, in order:
//   1. Key resolution — our platform key (env.anthropicApiKey) by default, or a caller-supplied
//      per-user BYOK key. BYOK calls BYPASS metering and the cap entirely (their key, their bill).
//   2. Budget check (metered calls only) — sum the user's month-to-date tokens from llm_usage and
//      apply the two-tier cap: general budget, then a pipeline-only reserve. Over budget throws a
//      typed BudgetExceededError carrying the reset date.
//   3. The call — feature → model tiering, then client.messages.create.
//   4. Record — write response.usage into llm_usage tagged with the feature. A metering-write
//      failure is logged and swallowed; it must NEVER fail the user's request.
//
// Presentation rule (enforced upstream in the usage endpoint + UI): raw token counts are internal
// to this module and the meter table. Callers get a Message or a typed error, never token numbers.

import Anthropic from '@anthropic-ai/sdk';
import { env } from '../env.js';
import { db } from '../db/index.js';

// The metered pipelines. Kept as data (mirrors the llm_usage.feature closed list) so adding a
// feature is additive. `voice_parse` and `digest` are PIPELINE features (may draw on the reserve);
// `chat` is interactive (pauses at the general cap).
export type LlmFeature = 'voice_parse' | 'chat' | 'digest';

const PIPELINE_FEATURES: ReadonlySet<LlmFeature> = new Set(['voice_parse', 'digest']);

// Thrown when a metered user is over budget. Carries the billing-window reset instant (ISO 8601) so
// the caller/UI can say "resets on <date>" without recomputing the window. Never carries token
// counts — the presentation rule holds even in error paths.
export class BudgetExceededError extends Error {
  readonly resetsAt: string;
  readonly feature: LlmFeature;

  constructor(feature: LlmFeature, resetsAt: string) {
    super('assistant_budget_exceeded');
    this.name = 'BudgetExceededError';
    this.feature = feature;
    this.resetsAt = resetsAt;
  }
}

// feature → model. voice_parse keeps VOICE_LLM_MODEL (already Haiku by default); chat and digest
// have their own env overrides, all defaulting to the cheap Haiku tier for now. BYOK users can pick
// a bigger model via these same env vars on their own instance.
function modelForFeature(feature: LlmFeature): string {
  switch (feature) {
    case 'voice_parse':
      return env.voiceLlmModel;
    case 'chat':
      return env.llm.chatModel;
    case 'digest':
      return env.llm.digestModel;
  }
}

// Calendar-month billing window in SERVER time (v1 — see ticket open question 1; the endpoint shape
// already carries resetsAt so an anchored-to-subscription version won't change the UI). `start` is
// the first instant of the current month; `resetsAt` is the first instant of next month, formatted
// as a stable local-date ISO string ("2026-08-01T00:00:00Z") so the client always renders the right
// calendar date regardless of its own timezone.
function billingWindow(now: Date = new Date()): { start: Date; resetsAt: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
  const p = (n: number) => String(n).padStart(2, '0');
  const resetsAt = `${nextMonth.getFullYear()}-${p(nextMonth.getMonth() + 1)}-01T00:00:00Z`;
  return { start, resetsAt };
}

// Month-to-date total tokens for one user: the four token columns summed at face value (open
// question 4 — cache reads counted at face value in v1). Purely internal; the number never leaves
// the server as a raw count.
async function monthToDateTokens(userId: number, start: Date): Promise<number> {
  const row = (await db('llm_usage')
    .where('user_id', userId)
    .andWhere('created_at', '>=', start)
    .select(
      db.raw(
        'COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) AS total',
      ),
    )
    .first()) as { total: number | string } | undefined;
  return Number(row?.total ?? 0);
}

// The user-facing meter state (ticket step 4). Percentage only — NO token counts — so the shape
// itself enforces the presentation rule. `capped` = the general budget is spent (chat is refused);
// pipeline features may still run from the reserve until it too is exhausted.
export interface UsageState {
  percent: number;
  warning: boolean;
  capped: boolean;
  resetsAt: string;
}

export async function getUsageState(userId: number, now: Date = new Date()): Promise<UsageState> {
  const { start, resetsAt } = billingWindow(now);
  const total = await monthToDateTokens(userId, start);
  const cap = env.llm.monthlyTokenCap;

  const rawPercent = cap > 0 ? Math.round((total / cap) * 100) : 0;
  const percent = Math.min(100, Math.max(0, rawPercent));

  return {
    percent,
    warning: percent >= 80,
    capped: total >= cap,
    resetsAt,
  };
}

// Record one call's usage. Best-effort: any failure here is logged and swallowed so a metering
// hiccup never turns a successful LLM call into a failed user request.
async function recordUsage(
  userId: number,
  feature: LlmFeature,
  model: string,
  usage: Anthropic.Usage,
): Promise<void> {
  try {
    await db('llm_usage').insert({
      user_id: userId,
      feature,
      model,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
    });
  } catch (err) {
    console.error('[llm] failed to record usage (call still succeeded):', err);
  }
}

export interface CallLlmOptions {
  userId: number;
  feature: LlmFeature;
  // The Anthropic request MINUS `model` — the gateway sets the model from the feature so tiering
  // lives in one place and callers can't accidentally route to the wrong model.
  request: Omit<Anthropic.MessageCreateParamsNonStreaming, 'model'>;
  // Future BYOK: a user's own Anthropic key. When present the call uses that key and is NEITHER
  // metered NOR capped. Wire the plumbing now; the settings UI that captures the key ships later.
  byokKey?: string;
}

// The one entry point. Returns the Anthropic Message, or throws BudgetExceededError when a metered
// user is over budget for the requested feature.
export async function callLLM(opts: CallLlmOptions): Promise<Anthropic.Message> {
  const { userId, feature, request, byokKey } = opts;

  // BYOK bypasses metering and the cap entirely. Otherwise this is a platform-key call and counts.
  const metered = !byokKey;

  if (metered) {
    const { start, resetsAt } = billingWindow();
    const total = await monthToDateTokens(userId, start);
    const cap = env.llm.monthlyTokenCap;
    const reserve = env.llm.reserveTokens;

    if (total >= cap + reserve) {
      // Even the pipeline reserve is exhausted — refuse everything.
      throw new BudgetExceededError(feature, resetsAt);
    }
    if (total >= cap && !PIPELINE_FEATURES.has(feature)) {
      // General budget spent: interactive chat pauses; pipeline features keep drawing on the reserve.
      throw new BudgetExceededError(feature, resetsAt);
    }
  }

  const apiKey = byokKey ?? env.anthropicApiKey;
  if (!apiKey) {
    // No key at all (self-host with no platform key and no BYOK). Callers that feature-detect via
    // env.anthropicApiKey never reach here; voice's try/catch degrades to the rules parser if they do.
    throw new Error('llm_no_api_key');
  }

  const model = modelForFeature(feature);
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({ ...request, model });

  if (metered) {
    await recordUsage(userId, feature, model, response.usage);
  }

  return response;
}
