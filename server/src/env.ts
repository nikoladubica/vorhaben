import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
config({ path: path.join(rootDir, '.env') });

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const nodeEnv = process.env.NODE_ENV ?? 'development';

export const env = {
  nodeEnv,
  port: Number(process.env.PORT ?? 4001),
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  // In production the server also serves the built client (single-origin self-host).
  // Points at the Vite build output; override with CLIENT_DIST_PATH if relocated.
  clientDistPath: process.env.CLIENT_DIST_PATH ?? path.join(rootDir, 'client', 'dist'),
  // Auth-cookie `secure` flag. Defaults to on in production, but self-hosters serving
  // over plain HTTP (no TLS/reverse proxy) must set COOKIE_SECURE=false so login works.
  cookieSecure:
    process.env.COOKIE_SECURE !== undefined
      ? process.env.COOKIE_SECURE === 'true'
      : nodeEnv === 'production',
  // Required secret for signing JWTs. In production there is NO fallback — the
  // process must fail fast if it is missing. In dev/self-host a stable fallback
  // keeps local setup frictionless.
  jwtSecret: required('JWT_SECRET', nodeEnv === 'production' ? undefined : 'dev-insecure-jwt-secret-change-me'),
  // Secret used to encrypt at-rest secrets (currently a self-hoster's bring-your-own assistant API
  // key — ticket 13). OPTIONAL: when unset we derive from jwtSecret so encryption works out of the
  // box for local/self-host, but operators can rotate it independently. Rotating it (or jwtSecret,
  // when this is unset) makes previously stored keys undecryptable — the user simply re-enters the
  // key; nothing crashes. Never write this to a .env file.
  assistantKeySecret: process.env.ASSISTANT_KEY_SECRET,
  // Voice-capture LLM structuring (§ voice-capture, step 4). Both are read straight from the
  // environment and are OPTIONAL — the LLM path activates only when anthropicApiKey is set;
  // otherwise capture degrades to the rules parser. Never write these to a .env file, and never
  // expose either value to the client (GET /api/voice/capabilities leaks only a boolean).
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  voiceLlmModel: process.env.VOICE_LLM_MODEL ?? 'claude-haiku-4-5',
  // Hosted-assistant metering (ticket 12; marketing-strategy §3.5). All server-side LLM calls made
  // with OUR platform key route through server/src/llm/gateway.ts, which meters tokens per user
  // against these caps. BYOK calls bypass metering entirely (their key, their bill). Values are env
  // overrides so no literal is scattered through call sites; the defaults are the decided model:
  //   - monthlyTokenCap: 5,000,000 general budget/user/month (~one month's revenue at worst case).
  //   - reserveTokens: a 300,000 top-up usable ONLY by pipeline features (voice_parse, digest)
  //     after the general budget is spent — chat pauses at the cap, workflows keep running.
  // Per-feature model tiering, each overridable; all default to the cheap Haiku tier for now.
  // Raw token counts are internal only and NEVER exposed to the client.
  llm: {
    monthlyTokenCap: Number(process.env.LLM_MONTHLY_TOKEN_CAP ?? 5_000_000),
    reserveTokens: Number(process.env.LLM_RESERVE_TOKENS ?? 300_000),
    chatModel: process.env.CHAT_LLM_MODEL ?? 'claude-haiku-4-5',
    digestModel: process.env.DIGEST_LLM_MODEL ?? 'claude-haiku-4-5',
  },
  db: {
    host: required('DB_HOST', 'localhost'),
    port: Number(process.env.DB_PORT ?? 3307),
    user: required('DB_USER', 'vorhaben'),
    password: required('DB_PASSWORD', 'vorhaben'),
    database: required('DB_NAME', 'vorhaben'),
  },
};
