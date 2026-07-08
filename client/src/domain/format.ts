// Display formatters shared by the project-detail screen. Amounts and hours arrive as decimal
// strings from the API and stay strings in state; these turn them into Swiss-style display
// strings only at render time. Never used to build a payload.

// Group an integer-part string with Swiss apostrophe thousands separators (7120 → 7'120).
// Uses U+2019 (right single quotation mark), matching the design file's CHF 7'120.
function groupThousands(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '’');
}

// "775.00" + "CHF" → "CHF 775"; "7120.5" → "CHF 7'120.50"; "-50" → "CHF -50". Cents show only
// when non-zero, matching the design (CHF 775, never CHF 775.00). Falls back to the raw string
// when the amount cannot be parsed.
export function formatMoney(amount: string, currency: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return currency ? `${currency} ${amount}` : amount;
  const negative = n < 0;
  const abs = Math.abs(n);
  const hasCents = Math.round(abs * 100) % 100 !== 0;
  const fixed = hasCents ? abs.toFixed(2) : String(Math.round(abs));
  const [intPart, dec] = fixed.split('.');
  const body = `${negative ? '-' : ''}${groupThousands(intPart)}${dec ? `.${dec}` : ''}`;
  return currency ? `${currency} ${body}` : body;
}

// "12.5" → "12.5", "8" → "8.0", "7.25" → "7.25". One decimal minimum matches the design's 8.0.
export function formatHours(hours: string): string {
  const n = Number(hours);
  if (!Number.isFinite(n)) return hours;
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 2,
  });
}

// "2026-06-30" → "30.06." — the compact day.month. used in the entry/time-log tables.
export function formatDayMonth(date: string): string {
  const [, m, d] = date.split('-');
  if (!m || !d) return date;
  return `${d}.${m}.`;
}

// "2025-09-01" → "01.09.2025" — full Swiss date used in the compensation panel.
export function formatFullDate(date: string): string {
  const [y, m, d] = date.split('-');
  if (!y || !m || !d) return date;
  return `${d}.${m}.${y}`;
}

// "2025-09-01" → "Sep 2025". Parse as UTC midnight to avoid a timezone off-by-one.
export function formatMonthYear(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// Today as YYYY-MM-DD (local), the default entry date and range upper bound.
export function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}
