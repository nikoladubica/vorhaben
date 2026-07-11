import { Router, raw } from 'express';
import { env } from '../env.js';
import { db } from '../db/index.js';
import { BudgetExceededError, getInvoiceScanUsage, resolveStoredByokKey } from '../llm/gateway.js';
import { canUseInvoiceScanner } from '../domain/entitlements.js';
import {
  extractInvoice,
  type AllowedMediaType,
  type ScanProjectContext,
} from '../invoices/extract.js';

// Invoice scanner (ticket 14). Mounted at /api/invoices behind requireAuth. The Max-tier feature:
// upload an invoice, one Sonnet call (via the ticket-12 gateway) extracts it and proposes a matched
// or new project + income entry. STATELESS in v1 — the only thing this endpoint writes is the scan's
// metering row (inside the gateway). Nothing about the invoice is persisted, and NO project or entry
// is created here: the client holds the proposal and, on the user's approval, calls the EXISTING
// project/entry endpoints. Uploaded files are processed in memory and discarded.
export const invoicesRouter = Router();

// Accepted upload types + the 10 MB ceiling, both enforced BEFORE any LLM call. Oversize bodies are
// rejected by the raw parser's `limit` (surfacing as the shared JSON 413 in app.ts); wrong types are
// rejected below.
const ALLOWED_MEDIA_TYPES: readonly AllowedMediaType[] = [
  'application/pdf',
  'image/png',
  'image/jpeg',
];
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// The upload arrives as the raw request body (Content-Type names the file type) rather than
// multipart: the codebase has no multipart parser and ticket 14 forbids adding a dependency for one.
// express.raw (part of Express, already a dependency) fills req.body with a Buffer for these types;
// any other Content-Type leaves req.body a non-Buffer, which we reject as unsupported.
const uploadParser = raw({ type: [...ALLOWED_MEDIA_TYPES], limit: MAX_UPLOAD_BYTES });

type EntitlementRow = { plan_tier: string | null } | undefined;

// Read the caller's Max-tier entitlement column.
async function loadPlanTier(userId: number): Promise<string | null> {
  const row = (await db('users').where({ id: userId }).first('plan_tier')) as EntitlementRow;
  return row?.plan_tier ?? null;
}

// The Content-Type header minus any parameters (";charset=", boundary, …), lower-cased.
function mediaTypeOf(header: string | undefined): string {
  return ((header ?? '').split(';')[0] ?? '').trim().toLowerCase();
}

function isAllowed(type: string): type is AllowedMediaType {
  return (ALLOWED_MEDIA_TYPES as readonly string[]).includes(type);
}

// Load the caller's active (non-deleted) projects for matching, plus the allowed project-type ids.
async function loadScanContext(
  userId: number,
): Promise<{ projects: ScanProjectContext[]; projectTypeIds: string[] }> {
  const rows = (await db('projects')
    .where('user_id', userId)
    .whereNull('deleted_at')
    .select('id', 'name', 'type', 'rate_currency')) as Array<{
    id: number;
    name: string;
    type: string;
    rate_currency: string | null;
  }>;
  const projects: ScanProjectContext[] = rows.map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    type: String(r.type),
    currency: r.rate_currency,
  }));

  const typeRows = (await db('project_types').orderBy('sort_order').select('id')) as Array<{
    id: string;
  }>;
  const projectTypeIds = typeRows.map((t) => String(t.id));

  return { projects, projectTypeIds };
}

// GET /api/invoices/capabilities — the client gates the whole feature on this (like voice's
// /capabilities). `available` is whether the feature can be offered at all: a platform key exists, OR
// this user has a usable BYOK key (a self-hoster with their own key). Self-host with neither →
// available:false → the client shows nothing. `entitled` is whether THIS user may actually run a
// scan (Max tier, or BYOK parity). `scans` is the fair-use counter for metered (platform-key) use;
// null for BYOK (unlimited). Leaks no key, model name, or token count.
invoicesRouter.get('/capabilities', async (req, res) => {
  const userId = req.userId as number;
  const byokKey = await resolveStoredByokKey(userId);
  const hasByok = Boolean(byokKey);

  const entitled = canUseInvoiceScanner({ plan_tier: await loadPlanTier(userId) }, hasByok);
  const available = Boolean(env.anthropicApiKey) || hasByok;

  res.json({
    available,
    entitled,
    // Counter is meaningful only for metered use; a BYOK user is uncapped.
    scans: hasByok ? null : await getInvoiceScanUsage(userId),
  });
});

// POST /api/invoices/scan — the scan itself. Order of checks (cheapest / most-protective first):
//   entitlement → file validation → monthly scan-count cap (metered only) → extract → return JSON.
invoicesRouter.post('/scan', uploadParser, async (req, res) => {
  const userId = req.userId as number;

  const byokKey = await resolveStoredByokKey(userId);
  const hasByok = Boolean(byokKey);
  const metered = !hasByok;

  // Entitlement (Max tier, or BYOK parity). A non-entitled hosted user gets 403 with an upgrade
  // message; a self-host instance with no platform key and no BYOK also lands here (feature off).
  if (!canUseInvoiceScanner({ plan_tier: await loadPlanTier(userId) }, hasByok)) {
    res.status(403).json({
      error: 'upgrade_required',
      message:
        'The invoice scanner is a Max-plan feature. Upgrade to Max, or add your own API key.',
    });
    return;
  }

  // File validation — type + presence — BEFORE any model call. (Size is enforced by the raw parser's
  // limit, which 413s above.) A non-matching Content-Type leaves req.body a non-Buffer.
  const mediaType = mediaTypeOf(req.headers['content-type']);
  const buffer = req.body as unknown;
  if (!Buffer.isBuffer(buffer) || !isAllowed(mediaType)) {
    res.status(415).json({ error: 'unsupported_media_type' });
    return;
  }
  if (buffer.length === 0) {
    res.status(422).json({ error: 'empty_upload' });
    return;
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    res.status(413).json({ error: 'payload_too_large' });
    return;
  }

  // Monthly scan-count cap (metered use only; BYOK is uncapped). Mirrors BudgetExceededError:
  // 429 with the reset date so the UI can say "resets on <date>".
  if (metered) {
    const usage = await getInvoiceScanUsage(userId);
    if (usage.used >= usage.cap) {
      res.status(429).json({ error: 'scan_cap_reached', resetsAt: usage.resetsAt });
      return;
    }
  }

  const { projects, projectTypeIds } = await loadScanContext(userId);

  try {
    const result = await extractInvoice({
      userId,
      file: buffer,
      mediaType,
      projects,
      projectTypeIds,
      byokKey,
    });
    res.json({
      invoice: result.invoice,
      proposal: result.proposal,
      // Refreshed counter (now including this scan's metering row) so the client updates the
      // "N of 100" surface without a second request. Null for BYOK (uncapped).
      scans: metered ? await getInvoiceScanUsage(userId) : null,
    });
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      // The token budget (separate from the scan-count cap) is spent.
      res.status(429).json({ error: 'assistant_budget_exceeded', resetsAt: err.resetsAt });
      return;
    }
    // Timeout, 429 from the API, 5xx, refusal — never surface the key or internals.
    console.error('[invoices] scan failed:', err);
    res.status(502).json({ error: 'extraction_failed' });
  }
});
