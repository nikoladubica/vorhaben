import { Router } from 'express';
import { db } from '../db/index.js';

// ---------------------------------------------------------------------------
// Public digest routes (ticket 16) — the one-click unsubscribe
// ---------------------------------------------------------------------------
//
// Mounted WITHOUT requireAuth: the recipient clicks the link from their inbox, not the app, so it
// authenticates by the unguessable per-user token alone (32 random bytes). It flips digest_opt_in
// OFF for the matching user and returns a plain confirmation page. Idempotent: a second click on an
// already-off account still confirms. Unknown/absent tokens get a neutral page — the endpoint never
// reveals whether a token exists (no enumeration), and it is a pure opt-OUT so it can only ever
// reduce a user's mail, never enable it.

export const digestRouter = Router();

// A minimal Swiss confirmation page (self-contained; the recipient may not be logged in).
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { margin:0; background:#f6f4ef; color:#171512;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; }
  .card { max-width:460px; margin:12vh auto; background:#fff; border:1px solid #dcd8d0; padding:32px 30px; }
  .mark { font-size:12px; font-weight:700; letter-spacing:0.12em; text-transform:uppercase; }
  .mark .sq { display:inline-block; width:9px; height:9px; background:#d92b1c; margin-right:7px; }
  h1 { font-size:20px; letter-spacing:-0.015em; margin:16px 0 10px; }
  p { font-size:14px; line-height:1.55; color:#55524d; margin:0; }
</style>
</head>
<body>
  <div class="card">
    <div class="mark"><span class="sq"></span>VORHABEN</div>
    <h1>${title}</h1>
    <p>${body}</p>
  </div>
</body>
</html>`;
}

digestRouter.get('/unsubscribe', async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (token === '') {
    res
      .status(400)
      .type('html')
      .send(page('Invalid link', 'This unsubscribe link is missing its token.'));
    return;
  }

  try {
    const updated = await db('users')
      .where('digest_unsub_token', token)
      .update({ digest_opt_in: false });

    // Whether or not a row matched, answer the same way — the token is the only secret, and we do
    // not disclose which tokens are real.
    if (updated > 0) {
      res
        .type('html')
        .send(
          page(
            'You’re unsubscribed',
            'You will no longer receive the monthly Vorhaben digest. You can turn it back on any time in your settings.',
          ),
        );
    } else {
      res
        .type('html')
        .send(
          page(
            'Nothing to do',
            'This link is invalid or has already been used. If you still receive the digest, open your settings to turn it off.',
          ),
        );
    }
  } catch (err) {
    console.error('[digest] unsubscribe failed:', err);
    res
      .status(500)
      .type('html')
      .send(page('Something went wrong', 'Please try the link again in a moment.'));
  }
});
