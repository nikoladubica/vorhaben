// At-rest encryption for user secrets (ticket 13). The only current secret is a self-hoster's
// bring-your-own assistant API key; the helper is generic so any future secret uses the same path.
//
// Scheme: AES-256-GCM (authenticated) with a random 12-byte IV per value. The 32-byte key is derived
// once via scrypt from the instance secret (env.assistantKeySecret, falling back to jwtSecret) and a
// fixed application salt — so no key material is stored, and rotating the instance secret simply
// makes old ciphertexts undecryptable (decrypt() returns null; the user re-enters the key).
//
// Stored envelope is a single string: "v1:<ivB64>:<tagB64>:<cipherB64>". The version prefix lets a
// future scheme coexist. PLAINTEXT NEVER LEAVES THIS MODULE except through decrypt(), and is NEVER
// logged.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { env } from '../env.js';

const VERSION = 'v1';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
// Fixed, non-secret salt: the secrecy lives in the instance secret, not here. Constant so the same
// secret always derives the same key across restarts.
const KEY_SALT = 'vorhaben.secretBox.v1';

let cachedKey: Buffer | null = null;

function derivedKey(): Buffer {
  if (cachedKey) return cachedKey;
  const secret = env.assistantKeySecret ?? env.jwtSecret;
  cachedKey = scryptSync(secret, KEY_SALT, KEY_BYTES);
  return cachedKey;
}

/** Encrypt a non-empty plaintext into the versioned envelope string. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, derivedKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(
    ':',
  );
}

/**
 * Decrypt an envelope produced by encryptSecret. Returns null (never throws) on any malformed or
 * unauthenticated payload — e.g. after the instance secret was rotated — so callers degrade to
 * "no key" rather than crash.
 */
export function decryptSecret(payload: string): string | null {
  const parts = payload.split(':');
  const [version, ivB64, tagB64, cipherB64] = parts;
  if (parts.length !== 4 || version !== VERSION || !ivB64 || !tagB64 || !cipherB64) return null;
  try {
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ciphertext = Buffer.from(cipherB64, 'base64');
    const decipher = createDecipheriv(ALGO, derivedKey(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch {
    return null;
  }
}
