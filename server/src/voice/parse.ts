// Voice-capture rules parser (§ voice-capture, step 3). Pure, dependency-free, unit-tested: no
// DB, no I/O, no network. Turns a free-form transcript into a typed ParsedDraft the review UI can
// edit before anything is saved. The LLM path (voice/llm.ts) produces the same shape when a key is
// configured; this is the always-available fallback ("the LLM augments, never gates").
//
// The parser is deliberately conservative — keyword intent grammar + hand-rolled date detection +
// enumeration splitting. It never invents facts; anything it can't confidently extract is left for
// the user to fill in during review.

export interface ParsedProject {
  id: number;
  name: string;
}

export type ParsedKind = 'checklist' | 'note' | 'reminder' | 'event';

export interface ParsedDraft {
  kind: ParsedKind;
  kindConfidence: 'explicit' | 'inferred'; // explicit trigger word vs heuristic
  title: string;
  items: string[]; // checklist only
  body: string; // note only (Markdown)
  datetime: string | null; // ISO 8601 (local, no offset — matches datetime-local inputs)
  dateSuggestion: boolean; // a date was found but the kind is not reminder/event
  projectId: number | null;
  source: 'rules' | 'llm';
}

// ---------------------------------------------------------------------------
// Small string helpers
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Collapse ALL whitespace (including newlines) to single spaces. Used for single-line fields
// (titles, reminder text).
function collapseAll(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// Collapse spaces/tabs but PRESERVE newlines, so the checklist item splitter can still break on
// dictated line breaks (the manual textarea fallback may contain them; Web Speech transcripts
// usually don't).
function normSpace(s: string): string {
  return s
    .replace(/[^\S\n]+/g, ' ')
    .replace(/[^\S\n]*\n[^\S\n]*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// Strip recognizer filler ("um"/"uh") and a leading "I need to". Applied to whole clauses and to
// individual checklist items.
function stripFiller(s: string): string {
  return normSpace(s.replace(/\b(?:um|uh)\b/gi, ' ').replace(/^\s*i need to\s+/i, ''));
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// ---------------------------------------------------------------------------
// Project targeting
// ---------------------------------------------------------------------------

// A "for/on/to <name>" clause naming a known project attaches the capture to it. The clause can sit
// anywhere ("checklist for Acme call the bank …", "invoice the client on Acme") — not only at the
// tail — so we match "(for|on|to)" followed by the *leading words* of a known project name, taking
// as many of that name's words as are actually spoken. That way a short spoken name ("for Acme")
// attaches to a longer project ("Acme Redesign") without swallowing the words that follow, and a
// full "for Acme Redesign" attaches the same way. Longer word-matches win (a full name beats a bare
// first word), and only names in the user's own project list can match, so "remind me to invoice
// the client" never mistakes "invoice" for a project. The matched clause is stripped so it doesn't
// leak into the title/items.
function matchProject(
  text: string,
  projects: ParsedProject[],
): { projectId: number | null; cleaned: string } {
  // Longest names first so a full-name match is preferred at equal word counts.
  const sorted = [...projects].sort((a, b) => b.name.length - a.name.length);

  let best: { id: number; m: RegExpExecArray; words: number } | null = null;
  for (const p of sorted) {
    const nameWords = p.name.trim().split(/\s+/).filter(Boolean);
    // Try the longest leading prefix of this name first, shrinking to its first word.
    for (let k = nameWords.length; k >= 1; k--) {
      const prefix = nameWords.slice(0, k).map(escapeRegExp).join('\\s+');
      const m = new RegExp(`\\b(?:for|on|to)\\s+${prefix}\\b`, 'i').exec(text);
      if (m) {
        // Prefer the match that consumes the most name-words; tie-break on the earliest position.
        if (!best || k > best.words || (k === best.words && m.index < best.m.index)) {
          best = { id: p.id, m, words: k };
        }
        break; // longest prefix for THIS project found — move on
      }
    }
  }

  if (best) {
    const m = best.m;
    const cleaned = normSpace(text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length));
    return { projectId: best.id, cleaned };
  }

  return { projectId: null, cleaned: text };
}

// ---------------------------------------------------------------------------
// Date / time detection
// ---------------------------------------------------------------------------

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

// Hand-rolled (no chrono-style dependency). Resolves relative days, weekday names, numeric dates
// and a time-of-day against `now`, returns a local ISO 8601 string and the text with the matched
// phrases removed. Date-without-time defaults to 09:00; time-without-date uses today. Returns
// iso=null (and the text untouched) when nothing date-like is present.
function detectDateTime(text: string, now: Date): { iso: string | null; cleaned: string } {
  let working = text;
  let dateObj: Date | null = null;
  let hasTime = false;
  let hour = 0;
  let minute = 0;

  const cut = (m: RegExpExecArray) => {
    working = working.slice(0, m.index) + ' ' + working.slice(m.index + m[0].length);
  };

  // --- date component (first match wins) ---
  const isoRe = /\b(\d{4})-(\d{2})-(\d{2})\b/;
  const mdRe = new RegExp(
    `\\b(${MONTHS.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?\\b`,
    'i',
  );
  const dmRe = /\b(\d{1,2})\.(\d{1,2})\.(\d{4})?/;
  const relRe = /\b(today|tomorrow)\b/i;
  const wdRe = new RegExp(`\\b(?:next\\s+)?(${WEEKDAYS.join('|')})\\b`, 'i');

  let m: RegExpExecArray | null;
  if ((m = isoRe.exec(working))) {
    dateObj = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    cut(m);
  } else if ((m = mdRe.exec(working))) {
    const month = MONTHS.indexOf(m[1]!.toLowerCase());
    const day = Number(m[2]);
    const year = m[3] ? Number(m[3]) : now.getFullYear();
    let d = new Date(year, month, day);
    // A bare "July 10" already past this year rolls to next year.
    if (!m[3] && d < startOfDay(now)) d = new Date(year + 1, month, day);
    dateObj = d;
    cut(m);
  } else if ((m = dmRe.exec(working))) {
    const day = Number(m[1]);
    const month = Number(m[2]) - 1;
    const year = m[3] ? Number(m[3]) : now.getFullYear();
    let d = new Date(year, month, day);
    if (!m[3] && d < startOfDay(now)) d = new Date(year + 1, month, day);
    dateObj = d;
    cut(m);
  } else if ((m = relRe.exec(working))) {
    const base = startOfDay(now);
    if (m[1]!.toLowerCase() === 'tomorrow') base.setDate(base.getDate() + 1);
    dateObj = base;
    cut(m);
  } else if ((m = wdRe.exec(working))) {
    const target = WEEKDAYS.indexOf(m[1]!.toLowerCase());
    const base = startOfDay(now);
    // Next occurrence strictly in the future ("monday" said on Monday means the coming Monday).
    let diff = (target - base.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    base.setDate(base.getDate() + diff);
    dateObj = base;
    cut(m);
  }

  // --- time component (first match wins) ---
  let t: RegExpExecArray | null;
  const hmRe = /\bat\s+(\d{1,2}):(\d{2})\b/i;
  const apRe = /\bat\s+(\d{1,2})\s*(am|pm)\b/i;
  const bareRe = /\bat\s+(\d{1,2})\b/i;
  if ((t = hmRe.exec(working))) {
    hour = Number(t[1]);
    minute = Number(t[2]);
    hasTime = true;
    cut(t);
  } else if ((t = apRe.exec(working))) {
    hour = Number(t[1]) % 12;
    if (t[2]!.toLowerCase() === 'pm') hour += 12;
    minute = 0;
    hasTime = true;
    cut(t);
  } else if ((t = bareRe.exec(working))) {
    hour = Number(t[1]);
    minute = 0;
    hasTime = true;
    cut(t);
  }

  if (!dateObj && !hasTime) return { iso: null, cleaned: text };

  const d = dateObj ?? startOfDay(now);
  const h = hasTime ? hour : 9; // date-without-time defaults to 09:00
  const mi = hasTime ? minute : 0;
  const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(h)}:${pad(mi)}:00`;
  return { iso, cleaned: normSpace(working) };
}

// ---------------------------------------------------------------------------
// Checklist item splitting
// ---------------------------------------------------------------------------

// Split a clause into items on newlines, list commas, and the enumeration connectors
// then / after that / next / also / and. Filler is stripped per item; empties are dropped.
function splitItems(s: string): string[] {
  return s
    .split(/\s*(?:\n|,|\bafter that\b|\bthen\b|\bnext\b|\balso\b|\band\b)\s*/i)
    .map((x) => stripFiller(x))
    .filter((x) => x.length > 0);
}

// Title = text before the first item (a leading "<title>: a, b, c" clause) or the "Checklist"
// fallback. Everything else becomes the item list.
function splitChecklist(content: string): { title: string; items: string[] } {
  let title = 'Checklist';
  let listPart = content;
  const colon = content.indexOf(':');
  if (colon > 0 && colon < content.length - 1) {
    const before = collapseAll(content.slice(0, colon));
    const after = content.slice(colon + 1).trim();
    if (before.length > 0 && after.length > 0) {
      title = before;
      listPart = after;
    }
  }
  return { title, items: splitItems(listPart) };
}

function deriveNoteTitle(body: string): string {
  const t = collapseAll(body);
  if (t === '') return 'Note';
  if (t.length <= 60) return t;
  const cut = t.slice(0, 60);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut) + '…';
}

// ---------------------------------------------------------------------------
// parseTranscript
// ---------------------------------------------------------------------------

// `now` is injectable purely for deterministic tests; production callers pass two args and get the
// server clock.
export function parseTranscript(
  transcript: string,
  projects: ParsedProject[],
  now: Date = new Date(),
): ParsedDraft {
  const draft: ParsedDraft = {
    kind: 'note',
    kindConfidence: 'inferred',
    title: 'Note',
    items: [],
    body: '',
    datetime: null,
    dateSuggestion: false,
    projectId: null,
    source: 'rules',
  };

  const raw = normSpace(transcript ?? '');
  if (raw === '') return draft;

  const noteLead = /^(?:take a note|new note|note)\b[:,-]?\s*/i;
  // Leading checklist triggers. Three families: an explicit noun ("checklist", "to-do list",
  // "task list"), a "make/create/start/new [a] …" phrase ("make a list", "make a checklist"), and a
  // bare "to-do" / "to do" (hyphen, space, or joined). "list" only triggers behind a make-verb so
  // "list the invoices we sent" isn't hijacked. `to[-\s]?do` matches "todo", "to-do", and "to do".
  const checklistLead =
    /^(?:(?:make|create|start|new)\s+(?:me\s+)?(?:a\s+|an\s+)?(?:to[-\s]?do\s+list|task\s+list|check\s?list|list)|to[-\s]?do(?:\s+list)?|task\s+list|check\s?list)\b[:,-]?\s*/i;
  const eventLead = /^(?:new event|event|schedule)\b[:,-]?\s*/i;
  const remindRe = /\bremind me\b/i;

  const remindMatch = remindRe.exec(raw);

  // --- intent grammar (first match wins) ---
  let kind: ParsedKind | null;
  let confidence: 'explicit' | 'inferred' = 'explicit';
  let content: string;

  if (noteLead.test(raw)) {
    kind = 'note';
    content = raw.replace(noteLead, '');
  } else if (remindMatch) {
    kind = 'reminder';
    content = normSpace(raw.slice(remindMatch.index + remindMatch[0].length));
  } else if (eventLead.test(raw) && detectDateTime(raw.replace(eventLead, ''), now).iso !== null) {
    // Rule 3: an event trigger only wins when a date is actually present.
    kind = 'event';
    content = raw.replace(eventLead, '');
  } else if (checklistLead.test(raw)) {
    kind = 'checklist';
    content = raw.replace(checklistLead, '');
  } else {
    // Rule 5: no trigger word — decide checklist-vs-note after the supporting passes.
    kind = null;
    confidence = 'inferred';
    content = raw;
  }

  // --- supporting passes (project targeting, then date/time, then filler) ---
  const pm = matchProject(content, projects);
  draft.projectId = pm.projectId;
  const dt = detectDateTime(pm.cleaned, now);
  content = stripFiller(dt.cleaned);

  if (kind === null) {
    // Rule 5 resolution: ≥2 items → an inferred checklist, otherwise an inferred note.
    const parsed = splitChecklist(content);
    if (parsed.items.length >= 2) {
      draft.kind = 'checklist';
      draft.title = parsed.title;
      draft.items = parsed.items;
    } else {
      draft.kind = 'note';
      draft.body = content;
      draft.title = deriveNoteTitle(content);
    }
    if (dt.iso) {
      draft.datetime = dt.iso;
      draft.dateSuggestion = true; // a date on a note/checklist only *suggests* a reminder
    }
    return draft;
  }

  draft.kind = kind;
  draft.kindConfidence = confidence;

  if (kind === 'reminder') {
    draft.datetime = dt.iso;
    draft.title = collapseAll(content.replace(/^to\s+/i, '')) || 'Reminder';
  } else if (kind === 'event') {
    draft.datetime = dt.iso;
    draft.title = collapseAll(content) || 'Event';
  } else if (kind === 'checklist') {
    const parsed = splitChecklist(content);
    draft.title = parsed.title;
    draft.items = parsed.items;
    if (dt.iso) {
      draft.datetime = dt.iso;
      draft.dateSuggestion = true;
    }
  } else {
    // note
    draft.body = content;
    draft.title = deriveNoteTitle(content);
    if (dt.iso) {
      draft.datetime = dt.iso;
      draft.dateSuggestion = true;
    }
  }

  return draft;
}
