// Hand-rolled RFC 4180 CSV serializer and parser (BUSINESS_LOGIC.md §8 — CSV export/import).
//
// One module, no dependency: the formats we move (a flat table dump) are simple enough that a
// parser library would buy mostly risk. The rules implemented here are the RFC 4180 core:
//   - fields are comma-separated, records CRLF-separated;
//   - a field is quoted with double quotes when it contains a comma, a quote, CR, or LF;
//   - a literal double quote inside a quoted field is written as two double quotes ("");
//   - export prepends a UTF-8 BOM so Excel opens non-ASCII content correctly;
//   - parsing tolerates LF or CRLF line endings and strips a leading BOM.
//
// Serialize takes rows keyed by column name so the caller controls the stable column order;
// parse returns raw string records (header included) so the caller maps header → index itself.

// A field needs quoting if it contains any of: double-quote, comma, CR, LF.
const NEEDS_QUOTE = /[",\r\n]/;

// ---------------------------------------------------------------------------
// Formula-injection guard (OWASP CSV/formula injection)
// ---------------------------------------------------------------------------
//
// A spreadsheet program treats a cell whose text begins with '=', '+', '-', or '@' as a formula,
// so a user-authored field like `=HYPERLINK(...)` or `@SUM(...)` becomes code on open. The fix is
// to write such a cell as literal text by prefixing a single quote — the conventional "this is
// text" marker — which our importer strips back off on the way in (see unescapeFormulaText) so the
// value round-trips exactly (and, importantly, still dedups against the un-prefixed stored row).
//
// The guard is deliberately value-aware, not column-aware: it fires ONLY on strings that BOTH start
// with a trigger AND are not a plain number. That single rule keeps every numeric column safe —
// a negative amount like "-50.00" is a finite number, so it is never prefixed and round-trips
// byte-for-byte — while still catching genuine text payloads like "-1+cmd" (not a number).
const FORMULA_TRIGGER = /^[=+\-@]/;

// True when `value` is text that a spreadsheet could execute as a formula: starts with a trigger
// char and is not parseable as a plain number (so "-50.00" / "+3" are treated as numeric, not text).
function isDangerousText(value: string): boolean {
  return FORMULA_TRIGGER.test(value) && Number.isNaN(Number(value));
}

/**
 * Neutralize a cell value for safe spreadsheet export. Non-strings pass through untouched (numbers,
 * null); a dangerous text string is prefixed with a single quote so it is rendered literally and
 * never evaluated. Shared by BOTH the CSV serializer (below) and the XLSX serializer (xlsx.ts) so
 * neither format is left unguarded.
 */
export function escapeFormulaText(value: unknown): unknown {
  if (typeof value === 'string' && isDangerousText(value)) {
    return `'${value}`;
  }
  return value;
}

/**
 * Reverse escapeFormulaText on import: drop a single leading quote when it guards a trigger char, so
 * an exported "'=SUM(...)" is read back as the original "=SUM(...)". A value that merely begins with
 * a quote NOT followed by a trigger (an ordinary apostrophe) is left alone. The one ambiguous case —
 * a hand-authored value that literally begins with `'` + a trigger — is the well-known, accepted
 * limitation of apostrophe-based formula guarding.
 */
export function unescapeFormulaText(value: string): string {
  if (value.length >= 2 && value[0] === "'" && FORMULA_TRIGGER.test(value.slice(1))) {
    return value.slice(1);
  }
  return value;
}

// Coerce one cell to its CSV text. null/undefined become an empty field; everything else is
// stringified. Amounts already arrive as exact decimal strings from mysql2, so String() does not
// reformat them.
function serializeField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (NEEDS_QUOTE.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Serialize a header + rows to RFC 4180 CSV text. `columns` fixes the column order and header
 * labels; each row is looked up by column name (missing keys → empty field). Records are joined
 * with CRLF and the whole document ends with a trailing CRLF. A UTF-8 BOM is prepended by default
 * so Excel reads UTF-8 correctly; pass `{ bom: false }` to omit it.
 */
export function serializeCsv(
  columns: readonly string[],
  rows: ReadonlyArray<Record<string, unknown>>,
  options: { bom?: boolean } = {},
): string {
  const { bom = true } = options;
  const lines: string[] = [];
  // The header labels are our own fixed column names (never a formula), so they skip the guard;
  // only untrusted data cells are run through escapeFormulaText.
  lines.push(columns.map(serializeField).join(','));
  for (const row of rows) {
    lines.push(columns.map((c) => serializeField(escapeFormulaText(row[c]))).join(','));
  }
  const body = `${lines.join('\r\n')}\r\n`;
  return bom ? `﻿${body}` : body;
}

// Thrown on a structurally invalid document (an unterminated quoted field). `line` is the 1-based
// physical line where parsing gave up, for a human-readable error.
export class CsvParseError extends Error {
  line: number;
  constructor(message: string, line: number) {
    super(message);
    this.name = 'CsvParseError';
    this.line = line;
  }
}

/**
 * Parse CSV text into an array of records, each an array of field strings. A leading UTF-8 BOM is
 * stripped; both LF and CRLF line endings are accepted; quoted fields may contain commas, quotes
 * (doubled), and newlines. The header row, if any, is returned as `records[0]` — mapping it to
 * column indices is the caller's job. A trailing newline does not produce an empty record.
 *
 * Throws CsvParseError if a quoted field is never closed.
 */
export function parseCsv(input: string): string[][] {
  // Strip a leading BOM if present (Excel-produced files carry one).
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  const rows: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  // `started` tracks whether the current record has seen any content (a field char, a quote, or a
  // comma) so a bare trailing newline is not mistaken for a real empty record.
  let started = false;
  let line = 1;

  const pushField = () => {
    record.push(field);
    field = '';
  };
  const pushRecord = () => {
    pushField();
    rows.push(record);
    record = [];
    started = false;
  };

  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      if (ch === '\n') line += 1;
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      started = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      pushField();
      started = true;
      i += 1;
      continue;
    }
    if (ch === '\r') {
      pushRecord();
      i += 1;
      if (text[i] === '\n') i += 1;
      line += 1;
      continue;
    }
    if (ch === '\n') {
      pushRecord();
      i += 1;
      line += 1;
      continue;
    }

    field += ch;
    started = true;
    i += 1;
  }

  if (inQuotes) {
    throw new CsvParseError('unterminated quoted field', line);
  }

  // Flush a final record that had content but no trailing newline.
  if (started || field !== '' || record.length > 0) {
    pushRecord();
  }

  return rows;
}

// A record produced by a blank line: exactly one empty field. Callers skip these so a trailing or
// stray blank line in an imported file is ignored rather than reported as an invalid row.
export function isBlankRecord(record: readonly string[]): boolean {
  return record.length === 1 && record[0] === '';
}
