// Typed fetch wrapper for the vorhaben API.
//
// The session lives in an httpOnly cookie set by the server — the client never
// holds or stores a token. Every request sends `credentials: 'include'` so the
// browser attaches the cookie; identity is resolved via `GET /api/auth/me`.

export class ApiError extends Error {
  status: number;
  error: string;
  fields?: Record<string, string>;

  constructor(status: number, error: string, fields?: Record<string, string>) {
    super(error);
    this.name = 'ApiError';
    this.status = status;
    this.error = error;
    this.fields = fields;
  }
}

type ErrorBody = { error?: string; fields?: Record<string, string> };

let onUnauthorized: (() => void) | null = null;

/**
 * Register a handler fired when an in-app request returns 401. The AuthProvider
 * uses this to drop to the anonymous state so the route guard can redirect.
 * The `/auth/me` bootstrap call opts out (see `me` option) to avoid a loop.
 */
export function setOnUnauthorized(fn: () => void) {
  onUnauthorized = fn;
}

type RequestOptions = {
  // When true, a 401 is treated as "anonymous" by the caller and does NOT fire
  // the global unauthorized handler (used only by the `/auth/me` bootstrap).
  silent401?: boolean;
};

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options?: RequestOptions,
): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: 'include',
  };

  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }

  const res = await fetch(`/api${path}`, init);

  if (!res.ok) {
    let parsed: ErrorBody = {};
    try {
      parsed = (await res.json()) as ErrorBody;
    } catch {
      // non-JSON error body; fall through with an empty shape
    }

    if (res.status === 401 && !options?.silent401) {
      onUnauthorized?.();
    }

    throw new ApiError(res.status, parsed.error ?? `request_failed_${res.status}`, parsed.fields);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  if (!text) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>('GET', path, undefined, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('POST', path, body, options),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PATCH', path, body, options),
  del: <T>(path: string, options?: RequestOptions) =>
    request<T>('DELETE', path, undefined, options),
};

// ————— legacy helpers, kept working on top of `api` —————

export interface Venture {
  id: number;
  name: string;
  description: string | null;
  status: 'idea' | 'active' | 'paused' | 'archived';
  created_at: string;
  updated_at: string;
}

export function getHealth() {
  return api.get<{ status: string; db: string }>('/health');
}

export function getVentures() {
  return api.get<Venture[]>('/ventures');
}
