import { environment } from '@config/config';
import { getSetting } from '@helpers/settings';

/**
 * The one HTML shell every outgoing email is poured into.
 *
 * ## Why the body is not authored as HTML
 *
 * Template bodies are plain text, stored in `NotificationTemplates` and editable
 * by admins in M8. `renderer.ts` refuses to be a template engine for a stated
 * reason — evaluating admin-authored strings is a server-side template injection
 * — and letting those same strings carry markup is the same hole with a
 * different name. So the body stays text, is HTML-escaped here, and only THIS
 * file decides what an email looks like. One layout, forty templates, and a
 * redesign is one commit rather than forty.
 *
 * ## Why tables and inline styles
 *
 * Mail clients are not browsers. Outlook renders with Word's engine, Gmail
 * strips `<style>` blocks from forwarded mail, and neither honours flexbox,
 * grid, or custom properties. The markup below is therefore built the way email
 * has always been built: nested tables for layout, every declaration inline. It
 * is not a shortcut and it is not legacy code that somebody forgot to modernise
 * — modern CSS here produces a broken email, which is worse than a dated one.
 *
 * ## What the reader gets
 *
 * A white card on a grey ground, the association's mark or name at the top, the
 * message as real paragraphs, one dark action button in the app's own style, and
 * a footer naming who sent it. Text-only clients get `toPlainText` instead, sent
 * as the `text` half of the same multipart message.
 */

/* --------------------------------------------------------------------------
   Design tokens, copied — not imported.

   These are `admin/src/theme/tokens.ts` values: `semantic.light.surface`, the
   `primary` action fill, `radius.md`/`radius.lg`, the neutral ramp. The backend
   cannot import from a frontend package, and an email cannot read a stylesheet,
   so the numbers are restated here with their source named. If the brand palette
   moves, this block moves with it.
   -------------------------------------------------------------------------- */
const TOKENS = {
  /** `semantic.light.bg` — the ground the card floats on. */
  pageBg: '#FAFAFA',
  /** `semantic.light.surface`. */
  cardBg: '#FFFFFF',
  /** `semantic.light.border`, the hairline. */
  border: '#E5E5E5',
  /** `semantic.light.fg` — headings and body copy. */
  fg: '#171717',
  /** `semantic.light.fgMuted` — the footer and the fallback link line. */
  fgMuted: '#737373',
  /** `button.primary` / `primaryFg`. */
  buttonBg: '#262626',
  buttonFg: '#FFFFFF',
  /** `radius.lg` for the card, `radius.md` for the button. */
  cardRadius: 10,
  buttonRadius: 8,
  /**
   * Not the app's font stack.
   *
   * The app runs a webfont; an email cannot load one reliably and a client that
   * fails to fetch it falls back to Times New Roman, which looks broken rather
   * than plain. This is the system stack every mail client already has.
   */
  font: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
} as const;

/** 600px is the width every mail client is known to render without reflowing. */
const CARD_WIDTH = 600;

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape before anything else touches the string.
 *
 * The body has already had `{{placeholders}}` substituted from a payload that
 * includes member-supplied text — a company name, a reviewer's rejection note.
 * An unescaped `<` there is a member writing markup into somebody else's inbox.
 */
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => ESCAPES[char]!);

/** Bare http(s) URL, to the first whitespace. */
const URL_PATTERN = /https?:\/\/[^\s<]+/g;

/** A line that is nothing but a link — the one the button is made from. */
const isUrlOnly = (line: string): boolean => /^https?:\/\/\S+$/.test(line.trim());

/** Blank-line-separated blocks, exactly as the template author wrote them. */
const toParagraphs = (body: string): string[] =>
  body
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

const linkify = (escaped: string): string =>
  escaped.replace(
    URL_PATTERN,
    (url) => `<a href="${url}" style="color:${TOKENS.fg};text-decoration:underline;">${url}</a>`,
  );

export interface EmailBranding {
  /** `organisation.name` — the sender as a member knows them. */
  organisationName: string;
  /** `organisation.support_email`, for the footer. Empty hides the line. */
  supportEmail: string;
  /**
   * Absolute, unauthenticated logo URL. Always set: `/public/branding/logo`
   * serves the bundled ILGDA lockup when the association has uploaded nothing,
   * because an email client cannot fall back to a text mark the way a browser
   * can — it renders a broken image and nothing else.
   */
  logoUrl: string;
}

/**
 * Branding for the footer and the masthead, read once per process.
 *
 * Cached because the drain sends in batches and these three values change about
 * once a year — a settings read per email is three queries per message for
 * information that is effectively constant. The cache is per-process and has no
 * invalidation: a logo uploaded today reaches emails when the API next restarts,
 * which is the trade this comment exists to make visible rather than hide.
 */
let cached: EmailBranding | null = null;

export const loadBranding = async (): Promise<EmailBranding> => {
  if (cached) return cached;

  const [name, supportEmail] = await Promise.all([
    getSetting('organisation.name'),
    getSetting('organisation.support_email'),
  ]);

  cached = {
    organisationName: name?.trim() || 'Association',
    supportEmail: supportEmail?.trim() ?? '',
    /*
      The public branding route, not a storage key: an inbox has no token, and
      `/api/v1/public/branding/:slot` is unauthenticated for exactly this reason
      (`settings.routes.ts`). Unconditional, because that route answers with the
      bundled lockup when nothing is uploaded (`branding.service.ts`).
    */
    logoUrl: `${environment.publicBaseUrl.replace(/\/+$/, '')}/api/v1/public/branding/logo`,
  };

  return cached;
};

/** Test seam: the cache is per-process and would otherwise outlive a test file. */
export const resetBrandingCache = (): void => {
  cached = null;
};

export interface EmailLayoutInput {
  body: string;
  /** Words for the action button. The URL it opens is taken from the body. */
  ctaLabel: string;
  branding: EmailBranding;
}

/**
 * The plain-text half of the multipart message.
 *
 * Sent unchanged: the template body already IS the plain-text email, and it is
 * what every reader saw before this layout existed. Clients that block HTML,
 * screen readers set to prefer text, and the spam filters that distrust an
 * HTML-only message all read this half.
 */
export const toPlainText = (body: string): string => body;

/**
 * Wrap a rendered plain-text body in the card.
 *
 * The first URL that sits alone on its own line becomes the button; every other
 * URL stays an inline link. That rule is not a guess about the templates — it is
 * how all forty are written (`prisma/seed/notificationTemplates.ts`): a
 * paragraph, a blank line, the link on a line of its own.
 *
 * A body with no such line simply gets no button, which is correct for the
 * messages that only report something.
 */
export const renderEmailHtml = ({ body, ctaLabel, branding }: EmailLayoutInput): string => {
  const blocks = toParagraphs(body);
  const buttonUrl = blocks.find((block) => isUrlOnly(block))?.trim() ?? null;

  const content = blocks
    .map((block) => {
      if (buttonUrl && block.trim() === buttonUrl) {
        /*
          `<table>` and not an `<a>` with padding: Outlook ignores padding on an
          anchor and renders a bare blue link where the button should be. A
          single-cell table with the fill on the cell is the shape that survives
          every client, and the `<a>` inside carries the text.
        */
        return [
          '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">',
          '<tr>',
          `<td align="center" bgcolor="${TOKENS.buttonBg}" style="border-radius:${TOKENS.buttonRadius}px;">`,
          `<a href="${buttonUrl}" style="display:inline-block;padding:12px 24px;font-family:${TOKENS.font};font-size:14px;font-weight:600;line-height:20px;color:${TOKENS.buttonFg};text-decoration:none;border-radius:${TOKENS.buttonRadius}px;">${escapeHtml(ctaLabel)}</a>`,
          '</td>',
          '</tr>',
          '</table>',
          /*
            No "paste this link instead" line under the button (client decision,
            2026-09-10).

            It was there for the client that strips an anchor, and so a member
            could read where a password link actually goes before clicking. Both
            are real, and both lose to the clutter of a wrapped token-bearing URL
            in every message. Restore this line if a client is ever found that
            drops the button.
          */
        ].join('');
      }

      /* Single newlines inside a block stay line breaks — an address, a list of
         document names — while blank lines have already split the blocks. */
      const html = linkify(escapeHtml(block)).replace(/\n/g, '<br />');

      return `<p style="margin:0 0 16px;font-family:${TOKENS.font};font-size:15px;line-height:24px;color:${TOKENS.fg};">${html}</p>`;
    })
    .join('');

  /*
    `alt` carries the association's name, so a client with images off — Outlook's
    default — still shows who wrote, in text, where the logo would have been.
  */
  const masthead = `<img src="${branding.logoUrl}" alt="${escapeHtml(branding.organisationName)}" height="36" style="display:block;border:0;height:36px;max-height:36px;width:auto;" />`;

  const footerLines = [
    `${escapeHtml(branding.organisationName)}`,
    branding.supportEmail
      ? `Questions? Write to <a href="mailto:${branding.supportEmail}" style="color:${TOKENS.fgMuted};">${escapeHtml(branding.supportEmail)}</a>.`
      : null,
  ].filter(Boolean) as string[];

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    /* Belt and braces: some clients honour this, the rest get the inline styles. */
    '<meta name="color-scheme" content="light only" />',
    '</head>',
    `<body style="margin:0;padding:0;background-color:${TOKENS.pageBg};">`,
    /*
      Outer table, full width, one centred cell. `<div align=center>` and
      `margin:0 auto` both fail somewhere; this is the arrangement that does not.
    */
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${TOKENS.pageBg};">`,
    '<tr>',
    '<td align="center" style="padding:32px 16px;">',
    `<table role="presentation" width="${CARD_WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${CARD_WIDTH}px;background-color:${TOKENS.cardBg};border:1px solid ${TOKENS.border};border-radius:${TOKENS.cardRadius}px;">`,
    '<tr>',
    `<td style="padding:28px 32px 8px;">${masthead}</td>`,
    '</tr>',
    '<tr>',
    `<td style="padding:8px 32px 24px;">${content}</td>`,
    '</tr>',
    '</table>',
    `<table role="presentation" width="${CARD_WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${CARD_WIDTH}px;">`,
    '<tr>',
    `<td style="padding:16px 32px 0;font-family:${TOKENS.font};font-size:12px;line-height:18px;color:${TOKENS.fgMuted};">${footerLines.join('<br />')}</td>`,
    '</tr>',
    '</table>',
    '</td>',
    '</tr>',
    '</table>',
    '</body>',
    '</html>',
  ].join('');
};
