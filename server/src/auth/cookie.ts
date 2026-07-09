import type { CookieOptions } from 'express';
import { env } from '../env.js';

/** Single source of truth for the auth cookie name. */
export const AUTH_COOKIE = 'token';

/** 30 days in milliseconds — must match the JWT expiry in token.ts. */
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Options for setting the auth cookie. `secure` follows env.cookieSecure so the
 * cookie still works over plain HTTP in local dev / HTTP self-host, while HTTPS
 * deployments (hosted, or self-host behind a TLS proxy) keep it on.
 */
export const authCookieOptions: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: env.cookieSecure,
  maxAge: THIRTY_DAYS_MS,
};

/**
 * Options for clearing the auth cookie. Must match the set options (minus
 * maxAge) or the browser will not clear it.
 */
export const clearAuthCookieOptions: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: env.cookieSecure,
};
