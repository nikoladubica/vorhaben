// The common ISO 4217 currency codes offered across the app (project rate currency,
// base currency, fx rates). Deliberately short — the free-text "Other…" affordance in
// settings covers anything not listed here. Labels follow the "CODE — Name" pattern.

export const CURRENCIES: { value: string; label: string }[] = [
  { value: 'CHF', label: 'CHF — Swiss franc' },
  { value: 'EUR', label: 'EUR — Euro' },
  { value: 'USD', label: 'USD — US dollar' },
  { value: 'GBP', label: 'GBP — Pound sterling' },
  { value: 'JPY', label: 'JPY — Japanese yen' },
  { value: 'CAD', label: 'CAD — Canadian dollar' },
  { value: 'AUD', label: 'AUD — Australian dollar' },
  { value: 'SEK', label: 'SEK — Swedish krona' },
];
