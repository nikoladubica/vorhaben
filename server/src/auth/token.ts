import jwt from 'jsonwebtoken';
import { env } from '../env.js';

const EXPIRY = '30d';

export function signToken(userId: number): string {
  return jwt.sign({ sub: String(userId) }, env.jwtSecret, { expiresIn: EXPIRY });
}

/**
 * Verify a JWT and return the numeric user id, or null on any failure
 * (invalid signature, expired, malformed, non-numeric subject). Never throws
 * outward.
 */
export function verifyToken(token: string): number | null {
  try {
    const payload = jwt.verify(token, env.jwtSecret);
    if (typeof payload === 'string' || typeof payload.sub !== 'string') {
      return null;
    }
    const userId = Number(payload.sub);
    return Number.isInteger(userId) ? userId : null;
  } catch {
    return null;
  }
}
