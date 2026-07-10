// Voice-capture LLM structuring (§ voice-capture, step 4). When an Anthropic API key is
// configured (hosted tier, or a self-hoster bringing their own key), the same transcript that the
// rules parser handles is upgraded to a single structured-output model call that produces cleaner
// titles, better item splitting, resolved dates and a project match. The LLM AUGMENTS, NEVER
// GATES: it is feature-detected via env.anthropicApiKey, and ANY failure (no key, timeout, 429,
// 5xx, refusal, malformed JSON) degrades to the Step-3 rules parser so the caller never 5xxs
// because the LLM hiccuped. The key and model name are never exposed to the client.

import Anthropic from '@anthropic-ai/sdk';
import { env } from '../env.js';
import { parseTranscript, type ParsedDraft, type ParsedProject } from './parse.js';

// True iff a key is present. GET /api/voice/capabilities returns exactly this boolean — never the
// key or the model name.
export function isLlmAvailable(): boolean {
  return Boolean(env.anthropicApiKey);
}

// The ParsedDraft shape MINUS `source`, expressed as a structured-output JSON schema:
// additionalProperties:false and every field in `required` (structured-output rules), no
// minLength/maxLength (unsupported), projectId nullable integer.
const PARSED_DRAFT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'kind',
    'kindConfidence',
    'title',
    'items',
    'body',
    'datetime',
    'dateSuggestion',
    'projectId',
  ],
  properties: {
    kind: { type: 'string', enum: ['checklist', 'note', 'reminder', 'event'] },
    kindConfidence: { type: 'string', enum: ['explicit', 'inferred'] },
    title: { type: 'string' },
    items: { type: 'array', items: { type: 'string' } },
    body: { type: 'string' },
    datetime: { type: ['string', 'null'] },
    dateSuggestion: { type: 'boolean' },
    projectId: { type: ['integer', 'null'] },
  },
};

function localDate(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

// Encodes the task, the four kinds + the Step-3 intent priorities, today's date, the project
// id+name list, and the guardrails. Built per request because the project list and "today" vary.
function buildSystemPrompt(projects: ParsedProject[], now: Date): string {
  const projectList =
    projects.length > 0
      ? projects.map((p) => `  - id ${p.id}: ${p.name}`).join('\n')
      : '  (none)';

  return [
    'You structure a short spoken transcript into ONE captured item for a project income tracker.',
    `Today is ${localDate(now)}. Resolve relative dates ("tomorrow", "next Friday", "at 5pm") against it.`,
    '',
    'Choose exactly one kind, applying these priorities (an explicit trigger always wins):',
    '  - checklist: an explicit "checklist"/"to-do list"/"to do"/"task list"/"make a list"/"make a checklist" (or make/create/start/new + list), OR an enumeration of 2+ actions.',
    '  - note: a leading "note"/"take a note", or the default when nothing else fits. `body` is Markdown (use "- " bullets for spoken lists).',
    '  - reminder: an explicit "remind me ..." ALWAYS wins over everything else. The text after it (minus the date) is the reminder text.',
    '  - event: a leading "event"/"schedule" together with a specific date/time.',
    '',
    'Date handling:',
    '  - datetime is ISO 8601 local time (e.g. "2026-07-10T17:00:00"); a date with no time defaults to 09:00. Use null when there is no date.',
    '  - A bare date on a note or checklist only SUGGESTS a reminder: set dateSuggestion=true and keep the kind unchanged. Never let a stray date flip a note/checklist into a reminder.',
    '  - kindConfidence is "explicit" when a trigger word chose the kind, otherwise "inferred".',
    '',
    'Project targeting — attach to a project only when the speaker clearly names one ("for/on/to <name>"). Return the matching id, else null. Do not guess. Known projects:',
    projectList,
    '',
    'Clean up recognizer noise (filler words, false starts) but NEVER invent items, facts, dates, or a project that was not spoken. items is only for checklists; body is only for notes.',
  ].join('\n');
}

const ALLOWED_KINDS: ReadonlyArray<ParsedDraft['kind']> = [
  'checklist',
  'note',
  'reminder',
  'event',
];

// Coerce the model's JSON into a trusted ParsedDraft. Structured outputs already guarantee the
// schema, but we still validate defensively: unknown kinds fall back to note, items are coerced to
// a string array, and a projectId the model invented (not in the user's list) is dropped to null.
function normalizeLlmDraft(
  raw: Record<string, unknown>,
  projects: ParsedProject[],
): ParsedDraft {
  const kind = ALLOWED_KINDS.includes(raw.kind as ParsedDraft['kind'])
    ? (raw.kind as ParsedDraft['kind'])
    : 'note';
  const kindConfidence = raw.kindConfidence === 'explicit' ? 'explicit' : 'inferred';
  const items = Array.isArray(raw.items)
    ? raw.items.filter((x): x is string => typeof x === 'string')
    : [];

  let projectId: number | null = null;
  if (typeof raw.projectId === 'number' && projects.some((p) => p.id === raw.projectId)) {
    projectId = raw.projectId;
  }

  return {
    kind,
    kindConfidence,
    title: typeof raw.title === 'string' ? raw.title : '',
    items,
    body: typeof raw.body === 'string' ? raw.body : '',
    datetime: typeof raw.datetime === 'string' && raw.datetime !== '' ? raw.datetime : null,
    dateSuggestion: raw.dateSuggestion === true,
    projectId,
    source: 'llm',
  };
}

// Structure a transcript with the LLM when a key is present, otherwise (and on ANY error) fall
// back to the rules parser. Exactly one model call per parse.
export async function structureTranscript(
  transcript: string,
  projects: ParsedProject[],
  now: Date = new Date(),
): Promise<ParsedDraft> {
  if (!env.anthropicApiKey) {
    return parseTranscript(transcript, projects, now);
  }

  try {
    const client = new Anthropic({ apiKey: env.anthropicApiKey });
    const res = await client.messages.create({
      model: env.voiceLlmModel,
      max_tokens: 2048,
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: PARSED_DRAFT_SCHEMA },
      },
      system: buildSystemPrompt(projects, now),
      messages: [{ role: 'user', content: transcript }],
    });

    const textBlock = res.content.find(
      (b): b is Anthropic.TextBlock => b.type === 'text',
    );
    if (!textBlock || textBlock.text.trim() === '') {
      throw new Error('LLM returned no text block');
    }

    const parsed = JSON.parse(textBlock.text) as Record<string, unknown>;
    return normalizeLlmDraft(parsed, projects);
  } catch (err) {
    // Timeout, 429, 5xx, refusal, malformed JSON — degrade to rules. The caller must NEVER 5xx
    // because the LLM hiccuped.
    console.error('[voice] LLM structuring failed; falling back to rules parser:', err);
    return parseTranscript(transcript, projects, now);
  }
}
