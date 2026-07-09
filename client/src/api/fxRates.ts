// FX-rate settings calls built on the shared `api` helper (credentials, JSON, and ApiError with
// the 422 `fields` map are handled there — see client/src/api.ts). `rate` stays a string end to
// end: the API delivers it as a string and never has the client round it.

import { api } from '../api';

// One stored rate: 1 `currency` = `rate` `base_currency`, dated `as_of` ('YYYY-MM-DD').
export interface FxRate {
  currency: string;
  base_currency: string;
  rate: string;
  as_of: string;
}

export function listRates(): Promise<FxRate[]> {
  return api.get<FxRate[]>('/fx-rates');
}

// Upsert a rate. `as_of` is optional — the server defaults it to today when blank.
export function upsertRate(input: {
  currency: string;
  rate: string;
  as_of?: string;
}): Promise<FxRate> {
  return api.put<FxRate>('/fx-rates', input);
}

export function deleteRate(currency: string, as_of: string): Promise<void> {
  return api.del<void>(`/fx-rates/${encodeURIComponent(currency)}/${encodeURIComponent(as_of)}`);
}
