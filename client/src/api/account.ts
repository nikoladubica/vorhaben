// Account settings calls built on the shared `api` helper (credentials, JSON, and ApiError with
// the `fields` map are handled there — see client/src/api.ts).

import { api } from '../api';
import type { User } from '../auth/auth-context';

// PATCH /api/account — change the base currency. Returns the updated user; a bad code yields a
// 400 ApiError with error 'invalid_base_currency'.
export function updateBaseCurrency(code: string): Promise<User> {
  return api.patch<User>('/account', { base_currency: code });
}
