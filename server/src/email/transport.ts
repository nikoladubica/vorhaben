import nodemailer from 'nodemailer';
import { env } from '../env.js';

// ---------------------------------------------------------------------------
// Outbound mail transport (ticket 16) — the ONE seam the digest job sends through
// ---------------------------------------------------------------------------
//
// Delivery is a self-hosted Postfix MTA reached over LOCAL SMTP (see
// .claude/docs/backend/email-digest.md); nodemailer just speaks SMTP to it. The transport is
// DEPENDENCY-INJECTED into the job so tests pass a stub and NO live mail server is required — the
// job never constructs a transport itself. createSmtpTransport() builds the real one from env only
// at the process entrypoint.

// The minimal surface the job depends on. nodemailer's Transporter satisfies it, and a test stub is
// a one-method object. Keeping it this narrow is what makes the send path testable offline.
export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface MailTransport {
  sendMail(message: MailMessage): Promise<unknown>;
}

/**
 * Build the real SMTP transport from env, or null when SMTP is not configured (SMTP_HOST unset) —
 * the digest feature is INERT on such instances and the job logs and exits. Auth is included only
 * when both SMTP_USER and SMTP_PASS are present (a local Postfix relay usually needs none).
 */
export function createSmtpTransport(): MailTransport | null {
  if (!env.smtp.host) return null;
  const auth =
    env.smtp.user && env.smtp.pass ? { user: env.smtp.user, pass: env.smtp.pass } : undefined;
  return nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    // Opportunistic TLS on outbound: upgrade via STARTTLS when the peer offers it, but don't
    // require a certificate for the local Postfix hop. Deliverability TLS is Postfix→recipient.
    secure: false,
    ignoreTLS: false,
    auth,
  });
}
