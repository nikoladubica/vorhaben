import { parseMonthPeriod, monthPeriod, type DigestModel } from '../domain/digest.js';

// ---------------------------------------------------------------------------
// Monthly digest email template (ticket 16) — design screen 13, as inline-styled HTML
// ---------------------------------------------------------------------------
//
// Reproduces the Swiss look of the mockup (hairlines, square marks, ONE red accent) with fully
// inline styles + a table skeleton so it survives real mail clients. Pure: a DigestModel and the
// two absolute links in, a { subject, html, text } out — no Knex, no clock — so it is unit-tested
// with a fixture model. Every dynamic value is HTML-escaped before it reaches the markup.

// Swiss palette, hardcoded (email clients can't read CSS variables). One red, the rest ink/greys.
const INK = '#171512';
const INK_2 = '#55524d';
const INK_3 = '#8a857e';
const HAIRLINE = '#dcd8d0';
const GRID = '#e8e5df';
const RED = '#d92b1c';
const PAPER = '#f6f4ef';
const SURFACE = '#ffffff';

export interface DigestEmailLinks {
  unsubscribeUrl: string;
  dashboardUrl: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Whole-unit money for display: "CHF 7,120". Digest figures are already rounded; the email shows no
// cents (the mockup doesn't). null → an em dash.
function money(value: number | null, currency: string): string {
  if (value === null) return '—';
  const grouped = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(value));
  return `${currency} ${grouped}`;
}

// The label of the month before the model's period ("June" → "May"), for "vs May" phrasing.
function prevMonthLabel(period: string): string {
  const p = parseMonthPeriod(period);
  if (!p) return '';
  return p.month === 1 ? monthPeriod(p.year - 1, 12).label : monthPeriod(p.year, p.month - 1).label;
}

// The hero subline pieces: "monthly-equivalent · ▲ 4.2% vs May · best month of 2026".
function heroSubParts(model: DigestModel): string[] {
  const parts = ['monthly-equivalent'];
  if (model.mom_percent !== null) {
    const arrow = model.mom_percent >= 0 ? '▲' : '▼';
    parts.push(`${arrow} ${Math.abs(model.mom_percent)}% vs ${prevMonthLabel(model.period)}`);
  }
  if (model.is_best_month) {
    parts.push(`best month of ${model.period.slice(0, 4)}`);
  }
  return parts;
}

/** The subject line, e.g. "June: CHF 7,120 — your best month this year". */
export function digestSubject(model: DigestModel): string {
  const head = `${model.month_label}: ${money(model.monthly_equivalent, model.base_currency)}`;
  if (model.monthly_equivalent === null) return `${model.month_label}: your Vorhaben digest`;
  if (model.is_best_month) return `${head} — your best month this year`;
  if (model.mom_percent !== null) {
    const dir = model.mom_percent >= 0 ? 'up' : 'down';
    return `${head} — ${dir} ${Math.abs(model.mom_percent)}% vs ${prevMonthLabel(model.period)}`;
  }
  return head;
}

// One label/value row of the three-row block.
function row(label: string, value: string): string {
  return `
        <tr>
          <td style="padding:10px 0;border-top:1px solid ${GRID};font-size:13.5px;color:${INK_2};">${escapeHtml(label)}</td>
          <td style="padding:10px 0;border-top:1px solid ${GRID};font-size:13.5px;color:${INK};font-weight:600;text-align:right;font-variant-numeric:tabular-nums;">${value}</td>
        </tr>`;
}

/**
 * Render the digest email (subject + HTML + plain-text alternative) for a model and its two links.
 * Pure and deterministic.
 */
export function renderDigestEmail(model: DigestModel, links: DigestEmailLinks): RenderedEmail {
  const c = model.base_currency;
  const unsub = escapeHtml(links.unsubscribeUrl);
  const dash = escapeHtml(links.dashboardUrl);

  const bestRate = model.best_by_rate
    ? `${escapeHtml(model.best_by_rate.name)} · ${money(model.best_by_rate.value, c)}/h`
    : '—';
  const biggest = model.biggest_earner
    ? `${escapeHtml(model.biggest_earner.name)} · ${money(model.biggest_earner.value, c)}`
    : '—';
  const attention = model.needs_attention
    ? `${escapeHtml(model.needs_attention.name)} · ${escapeHtml(model.needs_attention.detail)}`
    : '—';

  const heroSub = heroSubParts(model).map(escapeHtml).join(' · ');
  const hero = money(model.monthly_equivalent, c);

  const tip = model.suggestion
    ? `
        <div style="background:${PAPER};border-top:2px solid ${RED};padding:14px 16px;font-size:13px;line-height:1.55;color:${INK_2};">
          <b style="color:${INK};font-weight:600;">One suggestion:</b> ${escapeHtml(model.suggestion)}
        </div>`
    : '';

  const html = `<!-- Monthly digest — design screen 13 -->
<div style="background:${PAPER};padding:0;margin:0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};padding:32px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="width:520px;max-width:100%;background:${SURFACE};border:1px solid ${HAIRLINE};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${INK};">
          <tr>
            <td style="padding:28px 26px 24px;">
              <div style="font-size:12px;font-weight:700;letter-spacing:0.12em;color:${INK};text-transform:uppercase;">
                <span style="display:inline-block;width:9px;height:9px;background:${RED};margin-right:7px;"></span>VORHABEN
              </div>
              <h1 style="font-size:21px;font-weight:700;letter-spacing:-0.015em;margin:14px 0 18px;color:${INK};">${escapeHtml(model.month_label)}, in one look.</h1>
              <div style="font-size:36px;font-weight:700;letter-spacing:-0.02em;font-variant-numeric:tabular-nums;color:${INK};">${hero}</div>
              <div style="font-size:12px;color:${INK_3};margin-top:4px;">${heroSub}</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0;">
                ${row('Best effective rate', bestRate)}
                ${row('Biggest earner', biggest)}
                ${row('Needs attention', attention)}
              </table>
              ${tip}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 26px 20px;border-top:1px solid ${HAIRLINE};font-size:11.5px;color:${INK_3};line-height:1.5;">
              You get one email a month, that&#39;s the deal.
              <a href="${dash}" style="color:${INK_3};">Open dashboard</a> ·
              <a href="${unsub}" style="color:${INK_3};">Unsubscribe</a><br>
              Vorhaben tracks what you enter — it is not a wallet and holds no funds.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</div>`;

  const textLines = [
    `${model.month_label}, in one look.`,
    '',
    `${hero}  (${heroSubParts(model).join(' · ')})`,
    '',
    `Best effective rate:  ${model.best_by_rate ? `${model.best_by_rate.name} · ${money(model.best_by_rate.value, c)}/h` : '—'}`,
    `Biggest earner:       ${model.biggest_earner ? `${model.biggest_earner.name} · ${money(model.biggest_earner.value, c)}` : '—'}`,
    `Needs attention:      ${model.needs_attention ? `${model.needs_attention.name} · ${model.needs_attention.detail}` : '—'}`,
  ];
  if (model.suggestion) {
    textLines.push('', `One suggestion: ${model.suggestion}`);
  }
  textLines.push(
    '',
    'You get one email a month, that’s the deal.',
    `Open dashboard: ${links.dashboardUrl}`,
    `Unsubscribe: ${links.unsubscribeUrl}`,
    'Vorhaben tracks what you enter — it is not a wallet and holds no funds.',
  );

  return { subject: digestSubject(model), html, text: textLines.join('\n') };
}
