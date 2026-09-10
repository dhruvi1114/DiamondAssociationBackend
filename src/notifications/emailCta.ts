/**
 * What the action button says, per template.
 *
 * Only three of the forty templates carry a link today — the rest report
 * something and ask for nothing, and a button on those would be an invention.
 * The layout draws no button when the body has no link, so this map stays as
 * short as the templates make it.
 *
 * A label is written per template rather than shared, because the button is the
 * most-read word in the message: "Set your password" tells the reader what
 * happens next where "Open" makes them find out by clicking. Where a template
 * gains a link and nobody adds a label here, `DEFAULT_CTA_LABEL` keeps the
 * button working rather than shipping a blank one.
 */
export const CTA_LABELS: Record<string, string> = {
  /** `{{track_url}}` — the login-free page showing where the application is. */
  'application.submitted': 'Track your application',
  /** `{{resubmit_url}}` — the login-free correction form (reject/resubmit spec D-9). */
  'application.rejected': 'Correct your application',
  /** `{{reset_url}}` — one-time, 60-minute link. */
  'auth.password_reset': 'Set your password',
};

/** Deliberately vague, and deliberately not silent: a working button beats none. */
export const DEFAULT_CTA_LABEL = 'Open';

export const ctaLabelFor = (templateCode: string): string =>
  CTA_LABELS[templateCode] ?? DEFAULT_CTA_LABEL;
