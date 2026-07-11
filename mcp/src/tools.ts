// The MCP tool surface: thin wrappers over vorhaben REST endpoints.
//
// Design rules (ticket 17):
//   - Tools expose NORMALIZED data (monthly-equivalent revenue, effective hourly rate) that the
//     API already computed — never raw rows the model would have to do math on. The
//     normalization engine (BUSINESS_LOGIC.md §2.2) stays server-side.
//   - Every description says WHEN to call the tool, not just what it returns.
//   - No business logic here: a handler at most fans a request into two GETs and merges them.
//   - Writes store originals as given (original amount + currency); conversion stays server-side.

import type { VorhabenClient } from './apiClient.js';

// Allowed mood feelings (server/src/domain/constants.ts FEELINGS). Surfaced in the schema so the
// model picks a valid value rather than guessing and getting a 422.
const FEELINGS = [
  'happy',
  'sad',
  'miserable',
  'excited',
  'opportunistic',
  'pessimistic',
  'stressed',
  'grateful',
] as const;

// A minimal JSON Schema object for a tool's input. Kept deliberately small — matches the subset
// the MCP SDK's Tool.inputSchema accepts.
interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (client: VorhabenClient, args: Record<string, unknown>) => Promise<unknown>;
}

// --- argument helpers -------------------------------------------------------
// Small, explicit extractors so a bad argument fails loudly (and the model sees why) rather than
// silently sending `undefined` to the API.

function requireInt(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isInteger(n)) {
    throw new Error(`Argument "${key}" is required and must be an integer.`);
  }
  return n;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`Argument "${key}" is required and must be a non-empty string.`);
  }
  return v;
}

function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`Argument "${key}" must be a string.`);
  return v;
}

// amount/hours accept a number or a numeric string (the API takes both and returns strings).
function optAmount(args: Record<string, unknown>, key: string): number | string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number' || typeof v === 'string') return v;
  throw new Error(`Argument "${key}" must be a number or numeric string.`);
}

function requireAmount(args: Record<string, unknown>, key: string): number | string {
  const v = optAmount(args, key);
  if (v === undefined) throw new Error(`Argument "${key}" is required.`);
  return v;
}

// Build a body object with only the keys that were actually provided (so the API applies its own
// defaults for omitted optional fields, rather than receiving explicit nulls).
function compact(entries: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entries)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// Reusable schema fragments.
const projectIdProp = {
  project_id: { type: 'integer', description: 'The project id to scope this call to.' },
};
const dateRangeProps = {
  from: { type: 'string', description: 'Inclusive start date, YYYY-MM-DD (optional).' },
  to: { type: 'string', description: 'Inclusive end date, YYYY-MM-DD (optional).' },
};

export const tools: ToolDef[] = [
  // --- read tools -----------------------------------------------------------
  {
    name: 'list_projects',
    description:
      "List the user's projects (income sources) with status, type, and tags. Call this first " +
      'to discover project ids and names before using any project-scoped tool, or when the user ' +
      'asks what they are tracking. For normalized comparison figures (monthly-equivalent ' +
      'revenue, effective hourly rate) use get_dashboard or get_project instead — this list does ' +
      'not include them.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status: active, paused, ended, or idea.',
        },
        type: {
          type: 'string',
          description: 'Filter by project type (e.g. freelance_client, job).',
        },
        tag: { type: 'string', description: 'Filter to projects carrying this tag name.' },
      },
      additionalProperties: false,
    },
    handler: (client, args) =>
      client.request('GET', '/api/projects', {
        query: {
          status: optString(args, 'status'),
          type: optString(args, 'type'),
          tag: optString(args, 'tag'),
        },
      }),
  },
  {
    name: 'get_project',
    description:
      "Get one project's detail merged with its normalized headline metrics: monthly-equivalent " +
      'revenue, effective hourly rate, monthly net, total revenue/expenses, and hours in the ' +
      "trailing window — all in the user's base currency, computed server-side. Call this when " +
      "the user asks about a single project's performance or economics.",
    inputSchema: {
      type: 'object',
      properties: projectIdProp,
      required: ['project_id'],
      additionalProperties: false,
    },
    handler: async (client, args) => {
      const id = requireInt(args, 'project_id');
      const [project, metrics] = await Promise.all([
        client.request('GET', `/api/projects/${id}`),
        client.request('GET', `/api/projects/${id}/metrics`),
      ]);
      return { ...(project as object), metrics };
    },
  },
  {
    name: 'get_dashboard',
    description:
      'The flagship tool: the whole "where is my time best spent?" answer in one call. Returns ' +
      'projects ranked by monthly-equivalent revenue AND by effective hourly rate (the two ' +
      'rankings often disagree — that disagreement is the insight), plus trend, composition, ' +
      'timeline, currency warnings, AND the focus-suggestion callouts with their explanations. ' +
      'Call this for any "which project is best / most profitable / best per hour", "where should ' +
      'I focus", or overview question. Prefer it over adding up raw entries yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        months: {
          type: 'integer',
          description:
            'Horizon for trend/composition/timeline, 1–36 (default 6). Rankings always use the ' +
            'canonical trailing-quarter window regardless of this value.',
        },
      },
      additionalProperties: false,
    },
    handler: async (client, args) => {
      const months = args.months === undefined ? undefined : requireInt(args, 'months');
      const [dashboard, suggestions] = await Promise.all([
        client.request('GET', '/api/dashboard', { query: { months } }),
        client.request<{ suggestions: unknown[] }>('GET', '/api/dashboard/suggestions'),
      ]);
      // Merge the separate focus-heuristic payload in so the assistant can explain WHY vorhaben
      // flags a project, not just show the rankings.
      return { ...(dashboard as object), suggestions: suggestions.suggestions };
    },
  },
  {
    name: 'get_signals',
    description:
      "The mood-analysis engine's findings (First Signal sentences) plus drift nudges for the " +
      "user's projects — pure server-side heuristics, most-concerning first. Pairs with " +
      'get_dashboard: the dashboard says which project pays best, get_signals says which project ' +
      'is quietly drifting or where mood and revenue diverge. Call this when the user asks "what ' +
      'should I check on", "anything wrong", or "how are my projects doing" beyond the numbers.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (client) => client.request('GET', '/api/signals'),
  },
  {
    name: 'list_income_entries',
    description:
      'List the recorded income entries for one project, newest first, optionally within a date ' +
      'range. Call this when the user wants the individual dated amounts behind a project (e.g. ' +
      '"show me what I logged for Acme in June"). For totals or comparisons prefer get_project / ' +
      'get_dashboard, which return normalized figures instead of raw rows.',
    inputSchema: {
      type: 'object',
      properties: { ...projectIdProp, ...dateRangeProps },
      required: ['project_id'],
      additionalProperties: false,
    },
    handler: (client, args) =>
      client.request('GET', `/api/projects/${requireInt(args, 'project_id')}/entries`, {
        query: { from: optString(args, 'from'), to: optString(args, 'to') },
      }),
  },
  {
    name: 'list_time_logs',
    description:
      'List the time (hours) logged against one project, optionally within a date range. Call ' +
      'this when the user asks how many hours they put into a project or wants the raw time ' +
      'entries. The effective hourly rate that combines these hours with revenue comes from ' +
      'get_project / get_dashboard.',
    inputSchema: {
      type: 'object',
      properties: { ...projectIdProp, ...dateRangeProps },
      required: ['project_id'],
      additionalProperties: false,
    },
    handler: (client, args) =>
      client.request('GET', `/api/projects/${requireInt(args, 'project_id')}/time-logs`, {
        query: { from: optString(args, 'from'), to: optString(args, 'to') },
      }),
  },
  {
    name: 'search_notes',
    description:
      "Read the user's cross-project journal (Markdown notes), each tagged with its project " +
      'name. Pass an optional query to filter to notes whose title or body contains that text ' +
      '(case-insensitive substring). Call this when the user asks what they wrote about ' +
      'something, or to bring qualitative context to a numbers question.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Case-insensitive substring to filter notes by (optional).',
        },
      },
      additionalProperties: false,
    },
    handler: async (client, args) => {
      const notes = await client.request<Array<Record<string, unknown>>>('GET', '/api/notes');
      const query = optString(args, 'query');
      if (query === undefined || query.trim() === '') return notes;
      // Plain substring filter — a client-side convenience, not business logic (the API has no
      // search parameter). Never re-derives any normalized/computed value.
      const needle = query.toLowerCase();
      return notes.filter((n) => {
        const title = typeof n.title === 'string' ? n.title.toLowerCase() : '';
        const body = typeof n.body_md === 'string' ? n.body_md.toLowerCase() : '';
        return title.includes(needle) || body.includes(needle);
      });
    },
  },
  {
    name: 'list_reminders',
    description:
      "List the user's reminders, newest first, optionally filtered by status. Call this when " +
      'the user asks what they need to do or follow up on (e.g. "what am I forgetting", ' +
      '"anything to invoice").',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status: pending, done, or dismissed (optional).',
        },
      },
      additionalProperties: false,
    },
    handler: (client, args) =>
      client.request('GET', '/api/reminders', { query: { status: optString(args, 'status') } }),
  },
  {
    name: 'get_mood_history',
    description:
      "Get a project's mood check-in stream (how the user felt about it over time), newest " +
      'first, with any "why" notes. Call this when the user asks how they have felt about a ' +
      'project, or to explain a divergence between revenue and sentiment surfaced by get_signals.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdProp,
        limit: { type: 'integer', description: 'Max entries to return, 1–200 (default 50).' },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
    handler: (client, args) =>
      client.request('GET', `/api/projects/${requireInt(args, 'project_id')}/moods`, {
        query: { limit: args.limit === undefined ? undefined : requireInt(args, 'limit') },
      }),
  },

  // --- write tools ----------------------------------------------------------
  // MCP clients confirm each tool call with the user before running it, so writes are acceptable.
  // These mirror the web forms 1:1; originals (amount + currency) are stored as given and all
  // conversion/normalization stays server-side.
  {
    name: 'add_income_entry',
    description:
      'Record an income entry against a project: a dated amount in its original currency (e.g. ' +
      '"sold 3 units, €240, 2026-07-01"). Currency conversion happens server-side and never ' +
      'overwrites the original. Use when the user says they earned/received/were paid something. ' +
      'Negative amounts are allowed for refunds/corrections.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdProp,
        date: { type: 'string', description: 'Entry date, YYYY-MM-DD.' },
        amount: { type: ['number', 'string'], description: 'Amount in the original currency.' },
        currency: {
          type: 'string',
          description:
            '3-letter currency code (optional; defaults to the project or base currency).',
        },
        note: { type: 'string', description: 'Optional note, up to 500 chars.' },
      },
      required: ['project_id', 'date', 'amount'],
      additionalProperties: false,
    },
    handler: (client, args) =>
      client.request('POST', `/api/projects/${requireInt(args, 'project_id')}/entries`, {
        body: compact({
          date: requireString(args, 'date'),
          amount: requireAmount(args, 'amount'),
          currency: optString(args, 'currency'),
          note: optString(args, 'note'),
        }),
      }),
  },
  {
    name: 'add_expense_entry',
    description:
      'Record an expense against a project: a dated amount (money out) in its original currency. ' +
      'Turns revenue into profit for margin/product projects. Use when the user reports a cost or ' +
      'spend tied to a project. Conversion stays server-side.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdProp,
        date: { type: 'string', description: 'Expense date, YYYY-MM-DD.' },
        amount: {
          type: ['number', 'string'],
          description: 'Amount spent, in the original currency.',
        },
        currency: { type: 'string', description: '3-letter currency code (optional).' },
        note: { type: 'string', description: 'Optional note, up to 500 chars.' },
      },
      required: ['project_id', 'date', 'amount'],
      additionalProperties: false,
    },
    handler: (client, args) =>
      client.request('POST', `/api/projects/${requireInt(args, 'project_id')}/expenses`, {
        body: compact({
          date: requireString(args, 'date'),
          amount: requireAmount(args, 'amount'),
          currency: optString(args, 'currency'),
          note: optString(args, 'note'),
        }),
      }),
  },
  {
    name: 'log_time',
    description:
      'Log hours worked on a project. Hours is the total for the whole range (not per day); pass ' +
      'end_date only for a multi-day range. Logging hours is what unlocks the effective-hourly-' +
      'rate ranking. Use when the user says how long they spent on something.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdProp,
        date: { type: 'string', description: 'Start date (or the single day), YYYY-MM-DD.' },
        end_date: { type: 'string', description: 'Inclusive range end, YYYY-MM-DD (optional).' },
        hours: { type: ['number', 'string'], description: 'Total hours for the whole range, > 0.' },
        note: { type: 'string', description: 'Optional note.' },
      },
      required: ['project_id', 'date', 'hours'],
      additionalProperties: false,
    },
    handler: (client, args) =>
      client.request('POST', `/api/projects/${requireInt(args, 'project_id')}/time-logs`, {
        body: compact({
          date: requireString(args, 'date'),
          end_date: optString(args, 'end_date'),
          hours: requireAmount(args, 'hours'),
          note: optString(args, 'note'),
        }),
      }),
  },
  {
    name: 'create_note',
    description:
      "Add a Markdown note to a project's journal. Use when the user wants to jot something down " +
      'about a project — a status update, a decision, a complaint, a next step. Body supports ' +
      'Markdown and is stored verbatim.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdProp,
        title: { type: 'string', description: 'Note title, 1–255 chars.' },
        body_md: { type: 'string', description: 'Markdown body (optional).' },
      },
      required: ['project_id', 'title'],
      additionalProperties: false,
    },
    handler: (client, args) =>
      client.request('POST', `/api/projects/${requireInt(args, 'project_id')}/notes`, {
        body: compact({
          title: requireString(args, 'title'),
          body_md: optString(args, 'body_md'),
        }),
      }),
  },
  {
    name: 'create_reminder',
    description:
      'Create a reminder. Optionally attach it to a project and/or give it a due date/time. Use ' +
      'when the user wants to be reminded to do something ("remind me to invoice Acme next ' +
      'Friday"). An undated reminder is fine.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What to be reminded of, 1–1000 chars.' },
        remind_at: {
          type: 'string',
          description: 'Due datetime as local wall-clock "YYYY-MM-DDTHH:MM" (optional).',
        },
        project_id: {
          type: 'integer',
          description: 'Project to attach the reminder to (optional).',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    handler: (client, args) =>
      client.request('POST', '/api/reminders', {
        body: compact({
          text: requireString(args, 'text'),
          remind_at: optString(args, 'remind_at'),
          project_id: args.project_id === undefined ? undefined : requireInt(args, 'project_id'),
        }),
      }),
  },
  {
    name: 'log_mood',
    description:
      'Record a mood check-in for a project: how the user feels about it right now, with an ' +
      'optional one-line "why". Use when the user expresses a feeling about a project ("I\'m ' +
      'stressed about Acme"). Feeling history is kept, never averaged away.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdProp,
        value: {
          type: 'string',
          enum: [...FEELINGS],
          description: 'The feeling. One of the listed values, or null to clear.',
        },
        note: { type: 'string', description: 'Optional one-line reason, up to 1000 chars.' },
      },
      required: ['project_id', 'value'],
      additionalProperties: false,
    },
    handler: (client, args) => {
      // `value` may be null (clears the feeling) — pass it through explicitly rather than dropping
      // it, since the API requires the key to be present.
      const rawValue = args.value;
      if (
        rawValue !== null &&
        (typeof rawValue !== 'string' || !FEELINGS.includes(rawValue as (typeof FEELINGS)[number]))
      ) {
        throw new Error(`Argument "value" must be null or one of: ${FEELINGS.join(', ')}.`);
      }
      return client.request('POST', `/api/projects/${requireInt(args, 'project_id')}/moods`, {
        body: compact({ value: rawValue, note: optString(args, 'note') }),
      });
    },
  },
];
