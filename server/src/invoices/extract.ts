// Invoice extraction (ticket 14, step 2). ONE gateway call turns an uploaded invoice (PDF or image)
// into structured data AND a proposal for what to do with it — match an existing project or draft a
// new one, plus the income entry to add. Raw OCR is the easy part; the project matching and
// normalization-aware drafting is the Max-tier value.
//
// This module is READ-ONLY: it never writes a project or entry. It returns a proposal the user
// reviews and approves; the approval calls the existing project/entry endpoints. The single model
// call routes through the ticket-12 gateway as feature `invoice_scan`, so it is metered (one row per
// scan) or, for a BYOK key, billed to the user and skipped entirely — the gateway decides.

import type Anthropic from '@anthropic-ai/sdk';
import { callLLM } from '../llm/gateway.js';
import { COMPENSATION_MODELS, type CompensationModel } from '../domain/constants.js';

// The file types we accept. Validated by the route BEFORE any call reaches here; the union lets the
// content block below pick `document` (PDF) vs `image` without re-widening to string.
export type AllowedMediaType = 'application/pdf' | 'image/png' | 'image/jpeg';

// A project the model may match against. Mirrors the voice pattern (id + name), plus type/currency
// so the match is informed and a "create new" draft can inherit a sensible currency.
export interface ScanProjectContext {
  id: number;
  name: string;
  type: string;
  currency: string | null;
}

// ————— The proposal shape returned to the client (post-normalization) —————

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
  // Set when action is add_to_existing AND the id is one the user actually owns; null otherwise.
  project_id: number | null;
  // Set when action is create_project; null otherwise.
  new_project: ProposedNewProject | null;
  entry: ProposedEntry;
  confidence: Confidence;
  reasoning: string;
}

export interface ExtractionResult {
  invoice: ExtractedInvoice;
  proposal: Proposal;
}

// ————— Structured-output JSON schema (strict; mirrors server/src/voice/llm.ts) —————
// additionalProperties:false and every property in `required` per structured-output rules; optional-
// by-context fields (project_id, new_project) are nullable rather than absent.
function buildSchema(projectTypeIds: string[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['invoice', 'proposal'],
    properties: {
      invoice: {
        type: 'object',
        additionalProperties: false,
        required: ['vendor', 'date', 'total', 'currency', 'line_items'],
        properties: {
          vendor: { type: ['string', 'null'] },
          date: { type: ['string', 'null'] },
          total: { type: ['number', 'null'] },
          currency: { type: ['string', 'null'] },
          line_items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['description', 'amount'],
              properties: {
                description: { type: 'string' },
                amount: { type: ['number', 'null'] },
              },
            },
          },
        },
      },
      proposal: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'project_id', 'new_project', 'entry', 'confidence', 'reasoning'],
        properties: {
          action: { type: 'string', enum: ['add_to_existing', 'create_project'] },
          project_id: { type: ['integer', 'null'] },
          new_project: {
            type: ['object', 'null'],
            additionalProperties: false,
            required: ['name', 'type', 'compensation_model'],
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: projectTypeIds },
              compensation_model: { type: 'string', enum: [...COMPENSATION_MODELS] },
            },
          },
          entry: {
            type: 'object',
            additionalProperties: false,
            required: ['amount', 'currency', 'date', 'note'],
            properties: {
              amount: { type: ['number', 'null'] },
              currency: { type: ['string', 'null'] },
              date: { type: ['string', 'null'] },
              note: { type: ['string', 'null'] },
            },
          },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          reasoning: { type: 'string' },
        },
      },
    },
  };
}

function localDate(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

// Encodes the task, the user's projects (for matching), the allowed project types, today's date and
// the guardrails. Built per request because the project list and "today" vary.
function buildSystemPrompt(
  projects: ScanProjectContext[],
  projectTypeIds: string[],
  now: Date,
): string {
  const projectList =
    projects.length > 0
      ? projects
          .map(
            (p) =>
              `  - id ${p.id}: ${p.name} (type ${p.type}${p.currency ? `, ${p.currency}` : ''})`,
          )
          .join('\n')
      : '  (none)';

  return [
    'You do the income bookkeeping for a self-employed person who tracks their earnings in a',
    'project income tracker. You are given ONE invoice they ISSUED (income they are owed/paid),',
    'as a document or image. Extract its data AND propose how to file it.',
    `Today is ${localDate(now)}. Resolve any relative or partial dates against it; output dates as`,
    'ISO YYYY-MM-DD.',
    '',
    'Extract: vendor/client name, invoice date, total amount, ISO-4217 currency (e.g. EUR, USD,',
    'GBP), and the line items. Never invent a figure you cannot see; use null when a field is absent.',
    '',
    'Then propose ONE action:',
    '  - add_to_existing: the invoice clearly belongs to one of the known projects below (match on',
    '    client/vendor name even when wording differs — "Acme GmbH" invoice → an "Acme consulting"',
    '    project). Set project_id to that id and new_project to null.',
    '  - create_project: no known project fits. Set new_project (a short name, a type from the list,',
    '    and a compensation_model) and project_id to null. For a one-off issued invoice, freelance_gig',
    '    with the `variable` compensation model is the usual choice; pick a better fit if the invoice',
    '    clearly implies one (e.g. an ongoing retainer → freelance_client).',
    '',
    'Always fill `entry` with the income to record: amount (the invoice total), its currency, the',
    'invoice date, and a short note. Keep the ORIGINAL currency — never convert.',
    '',
    'Set confidence to high/medium/low for the PROPOSAL (the match or the draft), and reasoning to',
    'ONE short sentence for the review card. Use low when the client name is ambiguous or the match',
    'is a guess — the user will pick the project themselves.',
    '',
    'Allowed project types:',
    `  ${projectTypeIds.join(', ')}`,
    '',
    'Known projects:',
    projectList,
  ].join('\n');
}

// ————— Defensive normalization of the model output —————
// Structured outputs already guarantee the schema, but we validate defensively (as voice does):
// a project_id the model invented (not owned) is dropped, unknown types/models fall back, and a
// malformed number becomes null. Never throws on bad content — a low-confidence result still renders
// the editable review card rather than 5xx-ing.

const CURRENCY_RE = /^[A-Z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}
function currency(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return CURRENCY_RE.test(s) ? s : null;
}
function date(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return DATE_RE.test(s) ? s : null;
}

function normalizeInvoice(raw: Record<string, unknown>): ExtractedInvoice {
  const items = Array.isArray(raw.line_items) ? raw.line_items : [];
  return {
    vendor: str(raw.vendor),
    date: date(raw.date),
    total: num(raw.total),
    currency: currency(raw.currency),
    line_items: items
      .filter((it): it is Record<string, unknown> => typeof it === 'object' && it !== null)
      .map((it) => ({ description: str(it.description) ?? '', amount: num(it.amount) })),
  };
}

function normalizeProposal(
  raw: Record<string, unknown>,
  projects: ScanProjectContext[],
  projectTypeIds: string[],
  invoiceFallbackCurrency: string | null,
): Proposal {
  const ownedIds = new Set(projects.map((p) => p.id));

  let action: ProposalAction =
    raw.action === 'create_project' ? 'create_project' : 'add_to_existing';

  // Honor add_to_existing only when the id is really owned; otherwise fall back to create_project so
  // the client renders the "new project" draft (or, at low confidence, a project picker).
  let projectId: number | null = null;
  if (action === 'add_to_existing') {
    const id = num(raw.project_id);
    if (id !== null && ownedIds.has(id)) projectId = id;
    else action = 'create_project';
  }

  let newProject: ProposedNewProject | null = null;
  if (action === 'create_project') {
    const np = (
      typeof raw.new_project === 'object' && raw.new_project !== null ? raw.new_project : {}
    ) as Record<string, unknown>;
    const type =
      typeof np.type === 'string' && projectTypeIds.includes(np.type) ? np.type : 'other';
    const model =
      typeof np.compensation_model === 'string' &&
      (COMPENSATION_MODELS as readonly string[]).includes(np.compensation_model)
        ? (np.compensation_model as CompensationModel)
        : 'variable';
    newProject = {
      name: str(np.name) ?? str((raw.entry as Record<string, unknown>)?.note) ?? 'New project',
      type,
      compensation_model: model,
    };
  }

  const entryRaw = (typeof raw.entry === 'object' && raw.entry !== null ? raw.entry : {}) as Record<
    string,
    unknown
  >;
  const entry: ProposedEntry = {
    amount: num(entryRaw.amount),
    currency: currency(entryRaw.currency) ?? invoiceFallbackCurrency,
    date: date(entryRaw.date),
    note: str(entryRaw.note),
  };

  const confidence: Confidence =
    raw.confidence === 'high' || raw.confidence === 'medium' ? raw.confidence : 'low';

  return {
    action,
    project_id: projectId,
    new_project: newProject,
    entry,
    confidence,
    reasoning: str(raw.reasoning) ?? '',
  };
}

// ————— The one exported call —————

export interface ExtractInvoiceOptions {
  userId: number;
  file: Buffer;
  mediaType: AllowedMediaType;
  projects: ScanProjectContext[];
  projectTypeIds: string[];
  // The user's own key, when the route resolved one — passed through so the gateway skips metering
  // and the cap. Omitted for platform-key (metered) scans.
  byokKey?: string;
  now?: Date;
}

// Build the document/image content block for the upload. PDFs are a `document` block; PNG/JPEG are
// an `image` block. Both carry the bytes as base64 (the file never touches disk — ticket 14 forbids
// persisting uploads).
function fileBlock(file: Buffer, mediaType: AllowedMediaType): Anthropic.ContentBlockParam {
  const data = file.toString('base64');
  if (mediaType === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
}

// Runs the single scan call and returns the normalized extraction. Throws only when the gateway
// throws (BudgetExceededError when the token budget — separate from the scan-count cap — is spent, or
// a network/API failure); the route maps those to 429 / 502. A model that returns malformed JSON is
// NOT an error here: it yields a low-confidence result so the review card still renders.
export async function extractInvoice(opts: ExtractInvoiceOptions): Promise<ExtractionResult> {
  const { userId, file, mediaType, projects, projectTypeIds } = opts;
  const now = opts.now ?? new Date();

  const res = await callLLM({
    userId,
    feature: 'invoice_scan',
    byokKey: opts.byokKey,
    request: {
      max_tokens: 4096,
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: buildSchema(projectTypeIds) },
      },
      system: buildSystemPrompt(projects, projectTypeIds, now),
      messages: [
        {
          role: 'user',
          content: [
            fileBlock(file, mediaType),
            {
              type: 'text',
              text: 'Extract this invoice and propose how to file it, following the schema.',
            },
          ],
        },
      ],
    },
  });

  const textBlock = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  let parsed: Record<string, unknown> = {};
  if (textBlock && textBlock.text.trim() !== '') {
    try {
      parsed = JSON.parse(textBlock.text) as Record<string, unknown>;
    } catch {
      // Malformed JSON from an otherwise successful call → fall through to an empty, low-confidence
      // result. The user fills the review card in manually; nothing is ever written silently.
      parsed = {};
    }
  }

  const invoice = normalizeInvoice(
    (typeof parsed.invoice === 'object' && parsed.invoice !== null ? parsed.invoice : {}) as Record<
      string,
      unknown
    >,
  );
  const proposal = normalizeProposal(
    (typeof parsed.proposal === 'object' && parsed.proposal !== null
      ? parsed.proposal
      : {}) as Record<string, unknown>,
    projects,
    projectTypeIds,
    invoice.currency,
  );

  return { invoice, proposal };
}
