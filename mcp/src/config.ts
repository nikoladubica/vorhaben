// Configuration for the vorhaben MCP server, read entirely from environment variables.
//
// The MCP client (Claude Desktop / Claude Code) supplies these via the `env` block of its
// server config, so there is no dotenv file to load here. See .claude/docs/backend/mcp.md.
//
// Auth is Option A from ticket 17: the MCP server holds the user's own credentials (or a
// pre-issued JWT) and authenticates against the existing REST API exactly like the web client
// does — a cookie-backed session. No parallel auth scheme, no server changes, no DB access.

export interface Config {
  /** Base URL of the running vorhaben instance, no trailing slash, no `/api` suffix. */
  apiUrl: string;
  /** Account email — used to log in and to re-authenticate after the session expires. */
  email?: string;
  /** Account password — paired with `email`. */
  password?: string;
  /**
   * A pre-issued session JWT (the value of the `token` cookie). When set, it is used directly
   * and login is skipped. It cannot be auto-renewed on expiry, so `email`/`password` are the
   * more robust choice for a long-running server.
   */
  token?: string;
}

// The server's real default port is 4001 (server/src/env.ts, .env.example, README). A Docker
// self-host publishes the whole app on APP_PORT (default 8080) instead — set VORHABEN_API_URL
// to http://localhost:8080 in that case. Documented in .claude/docs/backend/mcp.md.
const DEFAULT_API_URL = 'http://localhost:4001';

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Read and validate configuration from the environment. Throws a clear, actionable error when
 * no usable credentials are present — the process should fail fast at startup rather than only
 * discovering the problem on the first tool call.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawUrl = clean(env.VORHABEN_API_URL) ?? DEFAULT_API_URL;
  // Strip a trailing slash so path joins stay clean (`${apiUrl}/api/...`).
  const apiUrl = rawUrl.replace(/\/+$/, '');

  const email = clean(env.VORHABEN_EMAIL);
  const password = clean(env.VORHABEN_PASSWORD);
  const token = clean(env.VORHABEN_TOKEN);

  const hasCredentials = email !== undefined && password !== undefined;
  if (!hasCredentials && token === undefined) {
    throw new Error(
      'No credentials configured. Set VORHABEN_EMAIL and VORHABEN_PASSWORD, or VORHABEN_TOKEN ' +
        '(a pre-issued session JWT). See .claude/docs/backend/mcp.md.',
    );
  }

  return { apiUrl, email, password, token };
}
