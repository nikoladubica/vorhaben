import { db } from '../db/index.js';
import { env } from '../env.js';
import {
  buildDigestForUser,
  ensureUnsubToken,
  previousMonthPeriod,
  parseMonthPeriod,
} from '../domain/digest.js';
import { renderDigestEmail } from '../email/digestTemplate.js';
import { createSmtpTransport, type MailTransport } from '../email/transport.js';

// ---------------------------------------------------------------------------
// Monthly digest job (ticket 16) — the ONE-SHOT script an OS timer triggers
// ---------------------------------------------------------------------------
//
// NOT a daemon. §7 is explicit that analysis is on-demand, not background, so there is NO in-process
// scheduler: a systemd timer / cron on the Hetzner host runs `npm run digest` once a month (see
// .claude/docs/backend/email-digest.md). The process builds the SMTP transport, runs, logs a
// summary and exits.
//
// For each OPTED-IN user with NO digest_runs row for the period: build the model, send, then record
// the run. The record is written AFTER a successful send and guarded by the unique (user_id, period)
// constraint, so a crash mid-run or a double invocation can never email a user twice for one month.
// The transport is injected (runMonthlyDigest takes it) so tests pass a stub — no live mail server.

export interface DigestRunSummary {
  period: string;
  sent: number;
  skippedAlreadySent: number;
  skippedNoContent: number;
  failed: number;
}

interface OptedInUser {
  id: number;
  email: string;
}

/**
 * Run the digest for `period` ("YYYY-MM"), sending through `transport`. Idempotent per period.
 *
 * @param transport the injected mail transport (real SMTP in production, a stub in tests).
 * @param period    the month to report; defaults to the full month before now.
 */
export async function runMonthlyDigest(
  transport: MailTransport,
  period: string = previousMonthPeriod().period,
): Promise<DigestRunSummary> {
  const target = parseMonthPeriod(period);
  if (target === null) throw new Error(`invalid digest period: ${period}`);

  const summary: DigestRunSummary = {
    period: target.period,
    sent: 0,
    skippedAlreadySent: 0,
    skippedNoContent: 0,
    failed: 0,
  };

  // Opted-in users only (§7). Scoped to those who explicitly turned the digest on.
  const users = await db('users')
    .where('digest_opt_in', true)
    .select<OptedInUser[]>('id', 'email');

  for (const user of users) {
    // Idempotency: skip anyone already sent this period. The unique constraint is the hard guard;
    // this check just avoids the work.
    const already = await db('digest_runs')
      .where({ user_id: user.id, period: target.period })
      .first();
    if (already) {
      summary.skippedAlreadySent++;
      continue;
    }

    try {
      const model = await buildDigestForUser(user.id, target.period);
      // Nothing worth mailing (no projects / no figures) — don't send an empty digest, and don't
      // record a run, so the user still gets the month's digest once they have data.
      if (model === null || !model.has_content) {
        summary.skippedNoContent++;
        continue;
      }

      const token = await ensureUnsubToken(user.id);
      const unsubscribeUrl = `${env.publicBaseUrl}/api/digest/unsubscribe?token=${encodeURIComponent(token)}`;
      const dashboardUrl = `${env.publicBaseUrl}/dashboard`;
      const email = renderDigestEmail(model, { unsubscribeUrl, dashboardUrl });

      await transport.sendMail({
        from: env.smtp.from,
        to: user.email,
        subject: email.subject,
        text: email.text,
        html: email.html,
      });

      // Record the run only after a successful send. A duplicate insert (race / re-run) throws on
      // the unique constraint — treat that as already-sent, never as a failure.
      try {
        await db('digest_runs').insert({ user_id: user.id, period: target.period });
        summary.sent++;
      } catch {
        summary.skippedAlreadySent++;
      }
    } catch (err) {
      summary.failed++;
      console.error(`[digest] failed for user ${user.id} (${target.period}):`, err);
    }
  }

  return summary;
}

// --- Entrypoint (run directly via `npm run digest --workspace server [YYYY-MM]`) ----------------

async function main(): Promise<void> {
  const transport = createSmtpTransport();
  if (transport === null) {
    console.error('[digest] SMTP_HOST is not set — mail is not configured; nothing sent.');
    return;
  }
  const periodArg = process.argv[2];
  const period = periodArg ?? previousMonthPeriod().period;
  const summary = await runMonthlyDigest(transport, period);
  console.log(
    `[digest] ${summary.period}: sent ${summary.sent}, ` +
      `already-sent ${summary.skippedAlreadySent}, no-content ${summary.skippedNoContent}, failed ${summary.failed}`,
  );
}

// ESM "am I the entrypoint?" check — true when this file is run directly, false when imported by a test.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  main()
    .then(() => db.destroy())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error('[digest] fatal:', err);
      await db.destroy().catch(() => undefined);
      process.exit(1);
    });
}
