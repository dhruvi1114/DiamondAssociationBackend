import { NotificationChannel, type PrismaClient } from '@prisma/client';

/**
 * Seeded notification templates (notification-architecture.md §4).
 *
 * M0 seeds only the two the foundation itself needs — signup OTP and password
 * reset — so M1 has something to queue against on day one. The rest of the
 * table in §4 is seeded by the cycle that raises those messages, because a
 * template whose trigger does not exist yet is dead content nobody proofreads.
 *
 * Placeholders are `{{name}}` and are substituted from `Notifications.payload_json`.
 * Copy follows design-system.md §4: sentence case, no exclamation marks, and a
 * clear next step.
 */
interface TemplateSeed {
  code: string;
  channel: NotificationChannel;
  locale: string;
  subject: string | null;
  body: string;
}

const TEMPLATES: TemplateSeed[] = [
  /* --- M4: application lifecycle -----------------------------------------
     Every message states where the applicant stands and what, if anything, is
     needed from them. "No action needed from you right now" prevents the most
     common support call there is (ux-principles.md §2). */
  {
    code: 'application.submitted',
    channel: NotificationChannel.EMAIL,
    locale: 'en',
    subject: 'We have your application ({{application_number}})',
    body: [
      'Hello,',
      '',
      'We have received the membership application for {{company_name}}.',
      'Reference: {{application_number}}',
      '',
      'It is now with {{stage_name}}. No action is needed from you right now —',
      'we will email you when there is a decision or if anything is missing.',
      '',
      'You can check on it at any time here. Keep this link — it is also how you',
      'would make a correction if the association asks for one, and there is no',
      'account or password to remember:',
      '',
      '{{track_url}}',
    ].join('\n'),
  },
  {
    code: 'application.submitted',
    channel: NotificationChannel.IN_APP,
    locale: 'en',
    subject: 'Application submitted',
    body: 'Application {{application_number}} is with {{stage_name}}. Nothing is needed from you right now.',
  },
  {
    code: 'application.stage_approved',
    channel: NotificationChannel.EMAIL,
    locale: 'en',
    subject: 'Your application has progressed ({{application_number}})',
    body: [
      'Hello,',
      '',
      'The membership application for {{company_name}} has passed {{stage_name}}',
      'and moved to the next stage.',
      '',
      'No action is needed from you right now — we will email you when there is',
      'a decision or if anything is missing.',
    ].join('\n'),
  },
  {
    code: 'application.stage_approved',
    channel: NotificationChannel.IN_APP,
    locale: 'en',
    subject: 'Application progressed',
    body: 'Your application passed {{stage_name}} and has moved to the next stage.',
  },
  /* RETIRED by the 2026-08-25 spec (D-1): Return is gone and nothing queues this
     any more — `application.rejected` carries the correction round now. The rows
     are kept, and kept correct, because notifications already sitting QUEUED in
     the outbox when this ships still have to render; a drain sweep that cannot
     resolve a template fails the row rather than skipping it. Delete once the
     outbox holds none of these. NOTE: the "sign in" line below was never true
     for a registration-only account — that dead end is exactly what the new
     flow fixes. */
  {
    code: 'application.returned',
    channel: NotificationChannel.EMAIL,
    locale: 'en',
    subject: 'Your application needs a correction ({{application_number}})',
    body: [
      'Hello,',
      '',
      'The association has sent the application for {{company_name}} back so you can',
      'correct something. Here is what they said:',
      '',
      '{{remarks}}',
      '',
      'Sign in, make the change and resubmit — nothing else is affected.',
    ].join('\n'),
  },
  {
    code: 'application.returned',
    channel: NotificationChannel.IN_APP,
    locale: 'en',
    subject: 'Correction needed',
    body: '{{remarks}}',
  },
  /* --- reject and resubmit (2026-08-25 spec) -------------------------------
     `application.rejected` is the ONLY message the applicant gets out of a
     rejection. Per-document ✗ marks are silent until the one Reject click
     (D-6), so this email has to carry all of it: the reviewer's overall note,
     the itemised reasons, how many attempts are left, and the way back in.

     **Payload contract**, produced by `buildRejectionPayload` in
     `public.service.ts` so the reject transaction, the "resend my link" path and
     the backfill script all render the same message:

       company_name        the trading name as submitted
       application_number  e.g. APP2026030042
       remarks             the reviewer's overall note (mandatory, D-3)
       document_reasons    one "Label: reason" line per ✗ document, joined by \n
       document_count      how many documents were marked ✗
       attempt             corrections spent, this one included
       max_resubmissions   the cap from `application.max_resubmissions`
       attempts_remaining  rounds left, or "" when the cap is 0 (unlimited)
       resubmit_url        the login-free link

     An unknown placeholder renders empty (renderer.ts), so a caller that misses
     one degrades the email rather than breaking the send. */
  {
    code: 'application.rejected',
    channel: NotificationChannel.EMAIL,
    locale: 'en',
    subject: 'Your application needs corrections ({{application_number}})',
    body: [
      'Hello,',
      '',
      'The association has reviewed the membership application for {{company_name}}',
      'and cannot accept it as it stands. Nothing is lost — you can correct it and',
      'send it back.',
      '',
      'What the reviewer said:',
      '{{remarks}}',
      '',
      'What needs replacing:',
      '{{document_reasons}}',
      '',
      'Anything the reviewer already accepted stays as it is — you will only be',
      'asked for the items above.',
      '',
      '{{attempts_remaining}} of {{max_resubmissions}} corrections remaining on this application.',
      '',
      'Correct it here. There is no account to sign in to and no password to set;',
      'the link opens your application directly:',
      '',
      '{{resubmit_url}}',
    ].join('\n'),
  },
  {
    code: 'application.rejected',
    channel: NotificationChannel.IN_APP,
    locale: 'en',
    subject: 'Corrections needed on your application',
    body: '{{remarks}} — {{attempts_remaining}} of {{max_resubmissions}} corrections remaining. Use the link emailed to you to correct and resend it.',
  },
  /* The other ending (D-5): the cap is reached, the link is dead, and the only
     honest next step is a fresh application. It deliberately does not say "reply
     and we will look again" — the association set a limit and this message has
     to mean it. */
  {
    code: 'application.closed',
    channel: NotificationChannel.EMAIL,
    locale: 'en',
    subject: 'Your application has been closed ({{application_number}})',
    body: [
      'Hello,',
      '',
      'The membership application for {{company_name}} has been closed.',
      '',
      'What the reviewer said:',
      '{{remarks}}',
      '',
      'This was the last of the {{max_resubmissions}} corrections the association',
      'allows on one application, so it cannot be sent back again and the',
      'correction link no longer works.',
      '',
      'You are welcome to apply again from the start whenever you are ready. If',
      'you would like to understand the decision first, contact the association',
      'office and quote {{application_number}}.',
    ].join('\n'),
  },
  {
    code: 'application.closed',
    channel: NotificationChannel.IN_APP,
    locale: 'en',
    subject: 'Application closed',
    body: 'Application {{application_number}} has been closed after {{max_resubmissions}} corrections. A new application can be started at any time.',
  },
  {
    code: 'application.approved',
    channel: NotificationChannel.EMAIL,
    locale: 'en',
    subject: 'Your membership is approved — one step left',
    body: [
      'Hello,',
      '',
      'The application for {{company_name}} has been approved.',
      'Your membership number is {{member_code}}.',
      '',
      'One step remains: invoice {{invoice_number}} for {{total_amount}} is due by',
      '{{due_date}}. Your membership starts the moment it is paid.',
      '',
      'Sign in to pay online or to download the invoice.',
    ].join('\n'),
  },
  {
    code: 'application.approved',
    channel: NotificationChannel.IN_APP,
    locale: 'en',
    subject: 'Membership approved',
    body: 'Approved — membership {{member_code}}. Pay invoice {{invoice_number}} ({{total_amount}}) by {{due_date}} to activate it.',
  },
  /* --- M7: events ---------------------------------------------------------
     Every message answers the same three questions in the same order: where the
     booking stands, what the reader must do, and what happens if they do
     nothing. The last one is the reason the payment messages name the date the
     seats are released — a deadline nobody was told is a deadline nobody meets. */
  {
    code: 'event.booking_pending_payment',
    channel: NotificationChannel.EMAIL,
    locale: 'en',
    subject: 'Your seats at {{event_title}} are held until {{expires_on}}',
    body: [
      'Hello,',
      '',
      '{{seat_count}} seat(s) at {{event_title}} on {{event_date}} are held for you.',
      'Booking reference {{registration_code}}.',
      '',
      'Invoice {{invoice_number}} for {{total_amount}} is payable by {{expires_on}}.',
      'Pay by bank transfer quoting {{invoice_number}}, then tell us the reference',
      'so we can confirm it.',
      '',
      'If we have not heard by {{expires_on}} the seats are released and offered',
      'to someone else.',
    ].join('\n'),
  },
  {
    code: 'event.booking_pending_payment',
    channel: NotificationChannel.IN_APP,
    locale: 'en',
    subject: 'Seats held — payment needed',
    body: '{{seat_count}} seat(s) at {{event_title}} held until {{expires_on}}. Pay invoice {{invoice_number}} ({{total_amount}}) to confirm them.',
  },
  {
    code: 'event.booking_awaiting_approval',
    channel: NotificationChannel.EMAIL,
    locale: 'en',
    subject: 'Your request for {{event_title}} is with the association',
    body: [
      'Hello,',
      '',
      'Your request for {{seat_count}} seat(s) at {{event_title}} on {{event_date}}',
      'has been received. Booking reference {{registration_code}}.',
      '',
      'This event is one the association reviews before confirming. Nothing is',
      'payable yet and no invoice has been raised — we will write again once a',
      'decision is made.',
      '',
      'No action is needed from you right now.',
    ].join('\n'),
  },
  {
    code: 'event.booking_approved',
    channel: NotificationChannel.EMAIL,
    locale: 'en',
    subject: 'Approved — please pay by {{expires_on}} to confirm {{event_title}}',
    body: [
      'Hello,',
      '',
      'Your request for {{event_title}} has been approved and {{seat_count}} seat(s)',
      'are held for you. Booking reference {{registration_code}}.',
      '',
      'Invoice {{invoice_number}} for {{total_amount}} is payable by {{expires_on}}.',
      '',
      'If we have not heard by then the seats are released.',
    ].join('\n'),
  },
  {
    code: 'event.booking_rejected',
    channel: NotificationChannel.EMAIL,
    locale: 'en',
    subject: 'Your request for {{event_title}} was not accepted',
    body: [
      'Hello,',
      '',
      'The association has not accepted your request for {{event_title}}',
      '(reference {{registration_code}}).',
      '',
      'Reason given: {{reason}}',
      '',
      'Nothing has been charged and no invoice was raised.',
    ].join('\n'),
  },
  {
    code: 'event.payment_received',
    channel: NotificationChannel.EMAIL,
    locale: 'en',
    subject: 'We have your payment details for {{event_title}}',
    body: [
      'Hello,',
      '',
      'Thank you — we have the payment details for booking {{registration_code}}',
      '(reference {{reference_no}}).',
      '',
      'Your seats stay held while we check the payment against our account. We',
      'will confirm as soon as that is done, usually within two working days.',
      '',
      'No action is needed from you right now.',
    ].join('\n'),
  },
  {
    code: 'event.payment_rejected',
    channel: NotificationChannel.EMAIL,
    locale: 'en',
    subject: 'We could not trace your payment for {{event_title}}',
    body: [
      'Hello,',
      '',
      'We could not match the payment for booking {{registration_code}}.',
      '',
      'What we were told: {{reason}}',
      '',
      'Your seats are still held until {{expires_on}}. Check the reference and',
      'send it again, or reply to this email and we will look into it.',
    ].join('\n'),
  },
  {
    code: 'event.booking_confirmed',
    channel: NotificationChannel.EMAIL,
    locale: 'en',
    subject: 'Confirmed — {{event_title}} on {{event_date}}',
    body: [
      'Hello {{attendee_name}},',
      '',
      'Your place at {{event_title}} is confirmed.',
      '',
      'Your code: {{attendee_code}}',
      'When: {{event_date}}',
      'Where: {{venue}}',
      '',
      'Bring this code with you. It is yours alone — each person on the booking',
      'has their own.',
    ].join('\n'),
  },
  {
    code: 'event.booking_confirmed',
    channel: NotificationChannel.IN_APP,
    locale: 'en',
    subject: 'Booking confirmed',
    body: 'Confirmed for {{event_title}} on {{event_date}}. Booking {{registration_code}}.',
  },
  {
    code: 'event.payment_reminder',
    channel: NotificationChannel.EMAIL,
    locale: 'en',
    subject: 'Reminder: {{event_title}} seats are released on {{expires_on}}',
    body: [
      'Hello,',
      '',
      '{{seat_count}} seat(s) at {{event_title}} are still held for you, but only',
      'until {{expires_on}}.',
      '',
      'Invoice {{invoice_number}} for {{total_amount}} is outstanding.',
      '',
      'If we have not heard by {{expires_on}} the seats are released and offered',
      'to someone else. If you have already paid, tell us the reference and we',
      'will match it.',
    ].join('\n'),
  },
  {
    code: 'event.booking_expired',
    channel: NotificationChannel.EMAIL,
    locale: 'en',
    subject: 'Your seats at {{event_title}} have been released',
    body: [
      'Hello,',
      '',
      'Booking {{registration_code}} was not paid by {{expires_on}}, so the',
      '{{seat_count}} seat(s) have been released and invoice {{invoice_number}}',
      'has been cancelled. Nothing is owed.',
      '',
      'The event may still have places. You are welcome to book again — note',
      'that the price is whatever applies on the day you rebook.',
    ].join('\n'),
  },
  {
    code: 'event.cancelled_refund',
    channel: NotificationChannel.EMAIL,
    locale: 'en',
    subject: '{{event_title}} has been cancelled — your money is being returned',
    body: [
      'Hello,',
      '',
      '{{event_title}} on {{event_date}} has been cancelled by the association.',
      '',
      'Reason: {{reason}}',
      '',
      'Booking {{registration_code}} is cancelled and {{total_amount}} is being',
      'returned to you. Refund {{refund_number}} has been raised; it reaches the',
      'account you paid from.',
      '',
      'Nothing is needed from you.',
    ].join('\n'),
  },
  {
    code: 'refund.approved',
    channel: NotificationChannel.EMAIL,
    locale: 'en',
    subject: 'Your refund {{refund_number}} has been approved',
    body: [
      'Hello {{name}},',
      '',
      'Refund {{refund_number}} for {{amount}} against invoice {{invoice_number}}',
      'has been approved and is being sent to the account you paid from.',
      '',
      // No date is promised. Bank transfers take as long as they take, and a
      // promise the association cannot keep is what generates the chasing email.
      'We will write again once it has gone, with the reference.',
      '',
      'Nothing is needed from you.',
    ].join('\n'),
  },
  {
    code: 'refund.completed',
    channel: NotificationChannel.EMAIL,
    locale: 'en',
    subject: '{{amount}} has been refunded to you',
    body: [
      'Hello {{name}},',
      '',
      'Refund {{refund_number}} for {{amount}} against invoice {{invoice_number}}',
      'has been sent to the account you paid from.',
      '',
      'Bank reference: {{reference}}',
      '',
      'It can take a few working days to appear. Quote the reference above if you',
      'need to ask your bank about it.',
    ].join('\n'),
  },
  {
    code: 'refund.rejected',
    channel: NotificationChannel.EMAIL,
    locale: 'en',
    subject: 'About your refund {{refund_number}}',
    body: [
      'Hello {{name}},',
      '',
      'Refund {{refund_number}} for {{amount}} against invoice {{invoice_number}}',
      'will not be going ahead.',
      '',
      'Reason: {{reason}}',
      '',
      'If that does not look right, reply to this email and we will look again.',
    ].join('\n'),
  },
  {
    code: 'event.cancelled_unpaid',
    channel: NotificationChannel.EMAIL,
    locale: 'en',
    subject: '{{event_title}} has been cancelled',
    body: [
      'Hello,',
      '',
      '{{event_title}} on {{event_date}} has been cancelled by the association.',
      '',
      'Reason: {{reason}}',
      '',
      'Booking {{registration_code}} is cancelled. Nothing was taken from you and',
      'nothing is owed — any invoice raised for it has been cancelled.',
    ].join('\n'),
  },
  {
    code: 'event.booking_cancelled_by_member',
    channel: NotificationChannel.EMAIL,
    locale: 'en',
    subject: 'Your booking for {{event_title}} is cancelled',
    body: [
      'Hello,',
      '',
      'Booking {{registration_code}} for {{event_title}} has been cancelled at your',
      'request, and the seats have been released.',
      '',
      '{{refund_note}}',
    ].join('\n'),
  },
  {
    code: 'auth.signup_otp',
    channel: NotificationChannel.EMAIL,
    locale: 'en',
    subject: 'Your verification code',
    body: [
      'Hello {{full_name}},',
      '',
      'Your verification code is {{otp}}.',
      'It expires in {{expiry_minutes}} minutes.',
      '',
      'If you did not create an account with {{organisation_name}}, you can ignore this email.',
    ].join('\n'),
  },
  {
    code: 'auth.password_reset',
    channel: NotificationChannel.EMAIL,
    locale: 'en',
    subject: 'Reset your password',
    body: [
      'Hello {{full_name}},',
      '',
      'Use the link below to set a new password. It expires in {{expiry_minutes}} minutes and can be used once.',
      '',
      '{{reset_url}}',
      '',
      'If you did not ask to reset your password, no action is needed — your current password still works.',
    ].join('\n'),
  },
];

export const seedNotificationTemplates = async (prisma: PrismaClient): Promise<number> => {
  for (const template of TEMPLATES) {
    await prisma.notificationTemplate.upsert({
      where: {
        code_channel_locale: {
          code: template.code,
          channel: template.channel,
          locale: template.locale,
        },
      },
      // Body and subject ARE updated: templates are content, and a correction
      // to the copy should reach the next message without a manual step.
      update: { subject: template.subject, body: template.body, is_active: true },
      create: { ...template, is_active: true },
    });
  }

  return TEMPLATES.length;
};
