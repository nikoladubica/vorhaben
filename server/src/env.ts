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
  // Voice-capture LLM structuring (§ voice-capture, step 4). Both are read straight from the
  // environment and are OPTIONAL — the LLM path activates only when anthropicApiKey is set;
  // otherwise capture degrades to the rules parser. Never write these to a .env file, and never
  // expose either value to the client (GET /api/voice/capabilities leaks only a boolean).
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  voiceLlmModel: process.env.VOICE_LLM_MODEL ?? 'claude-haiku-4-5',
  db: {
    host: required('DB_HOST', 'localhost'),
    port: Number(process.env.DB_PORT ?? 3307),
    user: required('DB_USER', 'vorhaben'),
    password: required('DB_PASSWORD', 'vorhaben'),
    database: required('DB_NAME', 'vorhaben'),
  },
};
