import { describe, expect, it } from 'vitest';

import { ctaLabelFor, DEFAULT_CTA_LABEL } from '@notifications/emailCta';
import { renderEmailHtml, toPlainText, type EmailBranding } from '@notifications/emailLayout';

/**
 * The email card (2026-09-10).
 *
 * These pin the three properties the layout exists to guarantee: member-supplied
 * text cannot become markup, a link on its own line becomes the button, and a
 * body without one gets no button at all.
 */

const branding: EmailBranding = {
  organisationName: 'ILGDA',
  supportEmail: 'support@example.org',
  logoUrl: 'https://api.example.org/api/v1/public/branding/logo',
};

/** The shipped `auth.password_reset` body, rendered. */
const RESET_BODY = [
  'Hello Parthik,',
  '',
  'Use the link below to set a new password. It expires in 60 minutes and can be used once.',
  '',
  'https://members.example.org/set-password?token=abc123',
  '',
  'If you did not ask to reset your password, no action is needed.',
].join('\n');

describe('renderEmailHtml', () => {
  it('turns a lone link into the button, labelled from the template', () => {
    const html = renderEmailHtml({
      body: RESET_BODY,
      ctaLabel: ctaLabelFor('auth.password_reset'),
      branding,
    });

    expect(html).toContain('Set your password');
    expect(html).toContain('href="https://members.example.org/set-password?token=abc123"');
    // The raw URL is no longer printed under the button (client decision).
    expect(html).not.toContain('If the button does not work');
  });

  it('draws no button when the body carries no link', () => {
    const html = renderEmailHtml({
      body: ['Hello,', '', 'The application for ABC has been approved.'].join('\n'),
      ctaLabel: 'Open',
      branding,
    });

    expect(html).not.toContain('<a href="http');
  });

  it('escapes member-supplied text rather than rendering it', () => {
    // A rejection remark is written by a reviewer and lands in someone's inbox.
    const html = renderEmailHtml({
      body: ['Reason given:', '', '<script>alert(1)</script> & "quoted"'].join('\n'),
      ctaLabel: 'Open',
      branding,
    });

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });

  it('keeps every paragraph, and single newlines as line breaks', () => {
    const html = renderEmailHtml({
      body: ['Hello,', '', 'Line one', 'line two.', '', 'Closing.'].join('\n'),
      ctaLabel: 'Open',
      branding,
    });

    expect(html.match(/<p /g)).toHaveLength(3);
    expect(html).toContain('Line one<br />line two.');
  });

  it('shows the logo, with the association name as its alt text', () => {
    const html = renderEmailHtml({ body: 'Hello,', ctaLabel: 'Open', branding });

    expect(html).toContain('<img src="https://api.example.org/api/v1/public/branding/logo"');
    // Images-off clients — Outlook's default — read this instead.
    expect(html).toContain('alt="ILGDA"');
  });

  it('sets the name in type when the API has no reachable address', () => {
    // Local development: Gmail proxies images and cannot fetch from localhost,
    // so a broken image icon is what a URL would actually produce.
    const html = renderEmailHtml({
      body: 'Hello,',
      ctaLabel: 'Open',
      branding: { ...branding, logoUrl: null },
    });

    expect(html).not.toContain('<img');
    expect(html).toContain('ILGDA');
  });

  it('sends the body unchanged as the text half', () => {
    expect(toPlainText(RESET_BODY)).toBe(RESET_BODY);
  });
});

describe('ctaLabelFor', () => {
  it('names the action for each template that carries a link', () => {
    expect(ctaLabelFor('application.submitted')).toBe('Track your application');
    expect(ctaLabelFor('application.rejected')).toBe('Correct your application');
    expect(ctaLabelFor('auth.password_reset')).toBe('Set your password');
  });

  it('keeps the button working for a template nobody has labelled', () => {
    expect(ctaLabelFor('event.some_future_template')).toBe(DEFAULT_CTA_LABEL);
  });
});
