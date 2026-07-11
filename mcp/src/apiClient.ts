// Thin HTTP client for the vorhaben REST API.
//
// This is the ONLY thing in the MCP workspace that talks to vorhaben, and it talks to it the
// same way the browser does: over HTTP, authenticated by the `token` session cookie. It holds
// no business logic, no normalization math, and no database access — every figure the tools
// return comes straight from the API (ticket 17, "thin adapter" constraint).

import type { Config } from './config.js';

/** The auth cookie name set by the API (server/src/auth/cookie.ts's AUTH_COOKIE). */
const AUTH_COOKIE = 'token';

export interface RequestOptions {
  /** Query-string parameters. Undefined/null values are omitted. */
  query?: Record<string, string | number | undefined | null>;
  /** JSON request body (for POST/PATCH/PUT). */
  body?: unknown;
}

/**
 * An API call that came back with a non-2xx status. Carries the status and parsed body so the
 * tool layer can hand the model a faithful, actionable error (e.g. a 422 field map) instead of
 * an opaque "request failed".
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly method: string,
    readonly path: string,
  ) {
    super(`${method} ${path} → ${status}: ${JSON.stringify(body)}`);
    this.name = 'ApiError';
  }
}

export class VorhabenClient {
  private cookie: string | undefined;

  constructor(private readonly config: Config) {
    // A pre-issued JWT is used verbatim as the session cookie; no login round-trip needed.
    if (config.token !== undefined) {
      this.cookie = `${AUTH_COOKIE}=${config.token}`;
    }
  }

  private get canLogIn(): boolean {
    return this.config.email !== undefined && this.config.password !== undefined;
  }

  /**
   * Exchange email + password for a session cookie via POST /api/auth/login, and remember it.
   * Mirrors the web client's login exactly (same endpoint, same cookie), so the MCP session
   * inherits the API's auth, ownership, soft-delete, and normalization rules for free.
   */
  private async login(): Promise<void> {
    if (!this.canLogIn) {
      throw new Error(
        'Session expired and no VORHABEN_EMAIL/VORHABEN_PASSWORD is configured to renew it. ' +
          'A VORHABEN_TOKEN cannot be auto-renewed — switch to email/password for a long run.',
      );
    }

    const res = await fetch(`${this.config.apiUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: this.config.email, password: this.config.password }),
    });

    if (!res.ok) {
      const body = await this.parseBody(res);
      throw new ApiError(res.status, body, 'POST', '/api/auth/login');
    }

    const token = this.extractAuthCookie(res);
    if (token === undefined) {
      throw new Error('Login succeeded but no auth cookie was returned by the API.');
    }
    this.cookie = `${AUTH_COOKIE}=${token}`;
  }

  /** Pull the `token` cookie value out of a response's Set-Cookie header(s). */
  private extractAuthCookie(res: Response): string | undefined {
    // Node's undici exposes getSetCookie() (one entry per cookie); fall back to the combined
    // header for other runtimes.
    const headers = res.headers as Headers & { getSetCookie?: () => string[] };
    const raw =
      typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : headers.get('set-cookie')
          ? [headers.get('set-cookie') as string]
          : [];

    for (const entry of raw) {
      const first = entry.split(';', 1)[0]?.trim();
      if (first && first.startsWith(`${AUTH_COOKIE}=`)) {
        return first.slice(AUTH_COOKIE.length + 1);
      }
    }
    return undefined;
  }

  private async parseBody(res: Response): Promise<unknown> {
    const text = await res.text();
    if (text === '') return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private buildUrl(path: string, query: RequestOptions['query']): string {
    const url = new URL(`${this.config.apiUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  /**
   * Perform an authenticated request. Logs in on demand if there is no session yet, and on a
   * 401 re-authenticates once and retries (covers a session that expired mid-run). Returns the
   * parsed JSON body on success; throws ApiError on any non-2xx response.
   */
  async request<T = unknown>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    if (this.cookie === undefined) {
      await this.login();
    }

    const send = async (): Promise<Response> => {
      const headers: Record<string, string> = { Cookie: this.cookie as string };
      let body: string | undefined;
      if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(options.body);
      }
      return fetch(this.buildUrl(path, options.query), { method, headers, body });
    };

    let res = await send();

    // A 401 means the cookie is missing/expired; try a fresh login exactly once, then retry.
    if (res.status === 401 && this.canLogIn) {
      this.cookie = undefined;
      await this.login();
      res = await send();
    }

    const parsed = await this.parseBody(res);
    if (!res.ok) {
      throw new ApiError(res.status, parsed, method, path);
    }
    return parsed as T;
  }
}
