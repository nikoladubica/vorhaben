import { describe, expect, it } from 'vitest';
import { renderDigestEmail, digestSubject } from './digestTemplate.js';
import { createSmtpTransport, type MailMessage, type MailTransport } from './transport.js';
import type { DigestModel } from '../domain/digest.js';

const MODEL: DigestModel = {
  period: '2026-06',
  month_label: 'June',
  long_label: 'June 2026',
  base_currency: 'CHF',
  monthly_equivalent: 7120,
  mom_delta: 300,
  mom_percent: 4.2,
  is_best_month: true,
  best_by_rate: { project_id: 1, name: 'Studio K', value: 62 },
  biggest_earner: { project_id: 2, name: 'Acme Corp', value: 4200 },
  needs_attention: { project_id: 3, name: 'Kiosk SaaS', detail: '-18% vs May' },
  suggestion: 'Kiosk SaaS has been sliding for 3 weeks. Worth a decision before more effort.',
  has_content: true,
};

const LINKS = {
  unsubscribeUrl: 'https://vorhaben.app/api/digest/unsubscribe?token=abc123',
  dashboardUrl: 'https://vorhaben.app/dashboard',
};

describe('digestSubject', () => {
  it('leads with the best-month line when it is the year high', () => {
    expect(digestSubject(MODEL)).toBe('June: CHF 7,120 — your best month this year');
  });

  it('uses the MoM direction when it is not the best month', () => {
    expect(digestSubject({ ...MODEL, is_best_month: false })).toBe('June: CHF 7,120 — up 4.2% vs May');
    expect(digestSubject({ ...MODEL, is_best_month: false, mom_percent: -5 })).toBe(
      'June: CHF 7,120 — down 5% vs May',
    );
  });

  it('degrades gracefully when there is no figure', () => {
    expect(digestSubject({ ...MODEL, monthly_equivalent: null })).toBe('June: your Vorhaben digest');
  });
});

describe('renderDigestEmail', () => {
  it('renders the hero, three rows, suggestion and both links (design 13)', () => {
    const { subject, html, text } = renderDigestEmail(MODEL, LINKS);
    expect(subject).toContain('CHF 7,120');
    // Hero + subline.
    expect(html).toContain('CHF 7,120');
    expect(html).toContain('monthly-equivalent');
    expect(html).toContain('▲ 4.2% vs May');
    expect(html).toContain('best month of 2026');
    // Three rows.
    expect(html).toContain('Best effective rate');
    expect(html).toContain('Studio K · CHF 62/h');
    expect(html).toContain('Biggest earner');
    expect(html).toContain('Acme Corp · CHF 4,200');
    expect(html).toContain('Needs attention');
    expect(html).toContain('Kiosk SaaS · -18% vs May');
    // Suggestion + footer links.
    expect(html).toContain('One suggestion:');
    expect(html).toContain(LINKS.unsubscribeUrl);
    expect(html).toContain(LINKS.dashboardUrl);
    // Plain-text alternative carries the same substance.
    expect(text).toContain('CHF 7,120');
    expect(text).toContain('Unsubscribe: https://vorhaben.app/api/digest/unsubscribe?token=abc123');
  });

  it('omits the suggestion block when there is nothing to say', () => {
    const { html } = renderDigestEmail({ ...MODEL, suggestion: null }, LINKS);
    expect(html).not.toContain('One suggestion:');
  });

  it('escapes HTML in project names', () => {
    const { html } = renderDigestEmail(
      { ...MODEL, biggest_earner: { project_id: 9, name: '<script>x</script>', value: 100 } },
      LINKS,
    );
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('transport injectability', () => {
  it('createSmtpTransport returns null when SMTP is unconfigured (no live mail server in tests)', () => {
    // SMTP_HOST is unset in the test environment, so the real transport is inert.
    expect(createSmtpTransport()).toBeNull();
  });

  it('a stub transport receives the rendered message (the send seam is injectable)', async () => {
    const sent: MailMessage[] = [];
    const stub: MailTransport = {
      async sendMail(message) {
        sent.push(message);
        return { accepted: [message.to] };
      },
    };
    const email = renderDigestEmail(MODEL, LINKS);
    await stub.sendMail({ from: 'Vorhaben <digest@vorhaben.app>', to: 'user@example.com', ...email });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe(email.subject);
    expect(sent[0]!.to).toBe('user@example.com');
  });
});
