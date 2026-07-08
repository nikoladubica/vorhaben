import { db } from '../db/index.js';

// ---------------------------------------------------------------------------
// FX conversion service (read-time only)
// ---------------------------------------------------------------------------
//
// Stored entry amounts/currencies are NEVER mutated. Conversion to a base currency happens
// here, at read time, off the global `fx_rates` table. Callers load a currency's rates once
// via loadRates() and then call convert() many times (a dashboard does exactly one rate query).
//
// Money is kept as fixed-2-decimal strings end to end — `amount` on income_entries is a string
// from mysql2 and we stay in that world to avoid float drift. Internally we do fixed-point
// BigInt math (cents × scaled-rate) so no parseFloat ever touches money.

// as_of is DATE_FORMAT'd to a 'YYYY-MM-DD' string; rate stays a string (decimal(18,8) from
// mysql2) — never parseFloat'd.
export type RateRow = { as_of: string; rate: string };

// currency → its rates against one base currency, sorted by as_of ASCENDING.
export type RatesByCurrency = Map<string, RateRow[]>;

export interface ConversionResult {
  // Both are fixed-2-decimal strings ("240.00"), matching how entry amounts travel elsewhere.
  amount: string;
  converted: string;
  // true when no rate exists for the pair; converted then equals amount (never throws).
  missing_rate: boolean;
}

// rate is stored at 8 decimal places; amounts/results are held to 2.
const RATE_SCALE = 8;
const MONEY_SCALE = 2;

/**
 * Load every fx_rate for `baseCurrency` in ONE query, grouped by source currency and each
 * group sorted by as_of ascending, so convert() can run repeatedly without re-querying.
 * `as_of` is a 'YYYY-MM-DD' string; `rate` is kept as a decimal string (no float parsing).
 */
export async function loadRates(baseCurrency: string): Promise<RatesByCurrency> {
  const rows = await db('fx_rates')
    .where('base_currency', baseCurrency)
    .select<Array<{ currency: string; as_of: string; rate: string }>>(
      'currency',
      db.raw("DATE_FORMAT(as_of, '%Y-%m-%d') as as_of"),
      'rate',
    )
    // Grouped by currency, ascending as_of: groups are contiguous and already ordered, so the
    // last element of each list is its most recent rate.
    .orderBy('currency')
    .orderBy('as_of', 'asc');

  const map: RatesByCurrency = new Map();
  for (const row of rows) {
    let list = map.get(row.currency);
    if (!list) {
      list = [];
      map.set(row.currency, list);
    }
    list.push({ as_of: row.as_of, rate: row.rate });
  }
  return map;
}

/**
 * Convert `amount` (in `currency`) to `baseCurrency` as of `date`, using a pre-loaded rate map.
 *
 * Rate selection:
 *   - Identity: when currency === baseCurrency, returns amount unchanged WITHOUT reading the
 *     map — works even when fx_rates (and the map) is empty.
 *   - At-or-before: otherwise picks the latest rate whose as_of <= date.
 *   - Fallback: if every stored rate for the pair is dated after `date`, uses the overall
 *     latest rate for the pair rather than failing.
 *   - Missing: if the pair has no rates at all, returns amount UNCONVERTED with
 *     missing_rate: true. NEVER throws on a missing rate (ticket 09 surfaces this flag).
 *
 * @param amount fixed-point money as a string ("240.00") or number; normalized to 2 dp.
 * @param currency  the amount's currency (char(3)).
 * @param baseCurrency  the currency to convert into.
 * @param date  'YYYY-MM-DD' as-of date for rate selection.
 * @param rates  map from loadRates(baseCurrency).
 */
export function convert(
  amount: string | number,
  currency: string,
  baseCurrency: string,
  date: string,
  rates: RatesByCurrency,
): ConversionResult {
  // Normalize the input amount to a canonical fixed-2 string for the return value. Falls back
  // to the raw string if it is unparseable (shouldn't happen for DB decimals).
  const amountCents = parseDecimalToScaled(String(amount), MONEY_SCALE);
  const amountStr =
    amountCents === null ? String(amount) : scaledToFixed(amountCents, MONEY_SCALE);

  // Identity — do not touch the rates map.
  if (currency === baseCurrency) {
    return { amount: amountStr, converted: amountStr, missing_rate: false };
  }

  const list = rates.get(currency);
  if (!list || list.length === 0 || amountCents === null) {
    // Unknown pair (or an amount we couldn't parse): return it unconverted.
    return { amount: amountStr, converted: amountStr, missing_rate: true };
  }

  // Latest rate at-or-before `date`; list is ascending so the last match wins.
  let chosen: RateRow | undefined;
  for (const row of list) {
    if (row.as_of <= date) chosen = row;
    else break;
  }
  // Fallback: no rate precedes the date → use the overall latest (last, since ascending).
  if (!chosen) chosen = list[list.length - 1];
  if (!chosen) {
    // Unreachable (list is non-empty), but keeps the return type total.
    return { amount: amountStr, converted: amountStr, missing_rate: true };
  }

  const rateScaled = parseDecimalToScaled(chosen.rate, RATE_SCALE);
  if (rateScaled === null) {
    return { amount: amountStr, converted: amountStr, missing_rate: true };
  }

  // converted_cents = round( amountCents(×10^2) · rateScaled(×10^8) / 10^8 )
  // The product carries 10^(2+8); dividing by 10^8 (the rate scale) leaves cents.
  const product = amountCents * rateScaled;
  const convertedCents = divRoundHalfAwayFromZero(product, 10n ** BigInt(RATE_SCALE));

  return {
    amount: amountStr,
    converted: scaledToFixed(convertedCents, MONEY_SCALE),
    missing_rate: false,
  };
}

// ---------------------------------------------------------------------------
// Fixed-point helpers (BigInt; no float math on money)
// ---------------------------------------------------------------------------

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

// Parse a decimal string into an integer scaled by 10^scale, rounding half away from zero when
// the source has more fractional digits than `scale`. Returns null when unparseable.
function parseDecimalToScaled(value: string, scale: number): bigint | null {
  const match = DECIMAL_RE.exec(value.trim());
  if (!match) return null;
  const negative = match[1] === '-';
  const intPart = match[2] ?? '0';
  const fracPart = match[3] ?? '';

  let frac: string;
  let roundUp = false;
  if (fracPart.length <= scale) {
    frac = fracPart.padEnd(scale, '0');
  } else {
    frac = fracPart.slice(0, scale);
    roundUp = fracPart.charCodeAt(scale) >= 53; // '5'
  }

  let result = BigInt(intPart) * 10n ** BigInt(scale) + BigInt(frac === '' ? '0' : frac);
  if (roundUp) result += 1n;
  return negative ? -result : result;
}

// Divide by a positive denominator, rounding half away from zero (symmetric for negatives).
function divRoundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const quotient = (abs + denominator / 2n) / denominator;
  return negative ? -quotient : quotient;
}

// Format an integer scaled by 10^scale back to a fixed-`scale`-decimal string.
function scaledToFixed(scaled: bigint, scale: number): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const divisor = 10n ** BigInt(scale);
  const whole = abs / divisor;
  const frac = (abs % divisor).toString().padStart(scale, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}
