// Invoice scanner API calls (ticket 14, Max tier). The scan endpoint takes a RAW file body (the
// server has no multipart parser), so it can't use the shared `api` helper — which always sends
// JSON. `scanInvoice` posts the File as the request body with its own Content-Type; everything else
// (credentials cookie, ApiError shape) matches the helper so callers handle errors identically.

import { ApiError } from '../api';
import type { CompensationModel } from '../types';

// ————— response shapes (mirror server/src/invoices/extract.ts) —————

export interface ExtractedLineItem {
  description: string;
  amount: number | null;
}

export interface ExtractedInvoice {
  vendor: string | null;
  date: string | null;
  total: number | null;
  currency: string | null;
  line_items: ExtractedLineItem[];
}

export type ProposalAction = 'add_to_existing' | 'create_project';
export type Confidence = 'high' | 'medium' | 'low';

export interface ProposedNewProject {
  name: string;
  type: string;
  compensation_model: CompensationModel;
}

export interface ProposedEntry {
  amount: number | null;
  currency: string | null;
  date: string | null;
  note: string | null;
}

export interface Proposal {
  action: ProposalAction;
  project_id: number | null;
  new_project: ProposedNewProject | null;
  entry: ProposedEntry;
  confidence: Confidence;
  reasoning: string;
}

// The fair-use scan counter — counts are user-facing (unlike tokens). Null when the user is BYOK
// (uncapped).
export interface ScanUsage {
  used: number;
  cap: number;
  resetsAt: string;
}

export interface ScanResult {
  invoice: ExtractedInvoice;
  proposal: Proposal;
  scans: ScanUsage | null;
}

// Gates the whole feature client-side (like GET /api/voice/capabilities): `available` = the feature
// can be offered at all (platform key present, or this user has a BYOK key); `entitled` = this user
// may run a scan (Max tier or BYOK parity); `scans` = the counter (null for BYOK).
export interface InvoiceCapabilities {
  available: boolean;
  entitled: boolean;
  scans: ScanUsage | null;
}

// The accepted upload types + ceiling, mirrored from the server so the client rejects bad files
// before spending a request.
export const ACCEPTED_TYPES = ['application/pdf', 'image/png', 'image/jpeg'] as const;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export function getInvoiceCapabilities(): Promise<InvoiceCapabilities> {
  // A plain GET goes fine through the shared helper.
  return import('../api').then(({ api }) => api.get<InvoiceCapabilities>('/invoices/capabilities'));
}

// POST /api/invoices/scan — raw file upload. Resolves the extraction proposal; rejects with an
// ApiError carrying the server's `error` string (upgrade_required, scan_cap_reached,
// unsupported_media_type, extraction_failed, …) so the page can branch on it.
export async function scanInvoice(file: File): Promise<ScanResult> {
  const res = await fetch('/api/invoices/scan', {
    method: 'POST',
    credentials: 'include',
    // The browser sends the File as the raw request body; Content-Type names the file type, which is
    // exactly what the server reads to pick document vs image.
    headers: { 'Content-Type': file.type },
    body: file,
  });

  if (!res.ok) {
    let parsed: { error?: string; fields?: Record<string, string> } = {};
    try {
      parsed = (await res.json()) as typeof parsed;
    } catch {
      // non-JSON error body — fall through with an empty shape
    }
    throw new ApiError(res.status, parsed.error ?? `request_failed_${res.status}`, parsed.fields);
  }

  return (await res.json()) as ScanResult;
}
