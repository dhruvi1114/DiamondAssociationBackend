import { SettingValueType, type PrismaClient } from '@prisma/client';

/**
 * Runtime-configurable settings (`docs/database-design.md` §G).
 *
 * Rules for what belongs here rather than in env:
 *  - an admin should be able to change it without a deploy → SystemSettings
 *  - it is a secret, or the process cannot start without it → env
 *
 * `is_public = true` means an unauthenticated frontend may read it. Nothing
 * with operational or commercial sensitivity is marked public.
 *
 * Deliberately minimal in M0: only settings the foundation itself honours.
 * Business settings (fees, renewal windows, GST) arrive with their cycle and
 * are blocked on OQ-2/OQ-6/OQ-8.
 */
interface SettingSeed {
  key: string;
  value: string;
  value_type: SettingValueType;
  group: string;
  description: string;
  is_public: boolean;
}

const SETTINGS: SettingSeed[] = [
  {
    key: 'notification.email_enabled',
    value: 'true',
    value_type: SettingValueType.BOOLEAN,
    group: 'notification',
    description:
      'Global kill switch for email delivery. FALSE leaves rows QUEUED rather than dropping them, so nothing is lost while the channel is muted (notification-architecture.md §7).',
    is_public: false,
  },
  {
    key: 'notification.whatsapp_enabled',
    value: 'false',
    value_type: SettingValueType.BOOLEAN,
    group: 'notification',
    description:
      'Global switch for WhatsApp delivery. FALSE until a provider is chosen (OQ-5); rows stay QUEUED and visible in the admin outbox.',
    is_public: false,
  },
  {
    key: 'notification.in_app_enabled',
    value: 'true',
    value_type: SettingValueType.BOOLEAN,
    group: 'notification',
    description: 'Global switch for the in-app bell feed.',
    is_public: false,
  },
  {
    key: 'organisation.name',
    value: 'Association',
    value_type: SettingValueType.STRING,
    group: 'organisation',
    description:
      'Display name used in emails, invoices and page titles. Placeholder until the client supplies branding (NFR-6).',
    is_public: true,
  },
  {
    key: 'organisation.support_email',
    value: 'support@example.org',
    value_type: SettingValueType.STRING,
    group: 'organisation',
    description: 'Address shown to members on error screens and in the footer of notifications.',
    is_public: true,
  },
  {
    key: 'application.max_resubmissions',
    value: '3',
    value_type: SettingValueType.NUMBER,
    group: 'application',
    description:
      'How many times a rejected application may be corrected and resubmitted before it closes permanently. 0 = unlimited. Set by the super admin; compared against MembershipApplications.resubmission_count when a reviewer rejects. Was 0 until the reject/resubmit spec (D-4, 2026-08-25) — unlimited retries meant REJECTED was unreachable and an application could be sent back forever.',
    is_public: false,
  },
  {
    key: 'registration.consent_text',
    value:
      'I confirm that the information and documents submitted are true and accurate to the best of my knowledge. I agree to the association processing this data for membership review.',
    value_type: SettingValueType.STRING,
    group: 'registration',
    description: 'Consent paragraph shown on the public registration form (spec D-14).',
    is_public: true,
  },
  {
    key: 'billing.invoice_due_days',
    value: '15',
    value_type: SettingValueType.NUMBER,
    group: 'billing',
    description: 'Days between an invoice being issued and falling due.',
    is_public: false,
  },
  {
    key: 'organisation.gstin',
    value: '',
    value_type: SettingValueType.STRING,
    group: 'organisation',
    description:
      'The association GSTIN, printed on tax invoices. EMPTY until the client supplies it (OQ-8) — a wrong GSTIN on a tax invoice is a compliance problem, so invoices must not be issued to real members while this is blank.',
    is_public: false,
  },
  {
    key: 'organisation.legal_name',
    value: 'Lab Grown Diamond Growers Federation',
    value_type: SettingValueType.STRING,
    group: 'organisation',
    description:
      'Legal name printed on invoices and receipts. Confirm with the client before go-live.',
    is_public: true,
  },
  {
    key: 'organisation.address',
    value: '',
    value_type: SettingValueType.STRING,
    group: 'organisation',
    description:
      'Registered office address, printed on invoices and receipts beneath the legal name. Multi-line; blank until the client supplies it.',
    is_public: true,
  },
  {
    key: 'organisation.logo',
    value: '',
    value_type: SettingValueType.STRING,
    group: 'organisation',
    description:
      'Storage key of the full logo (wordmark), shown on the member portal header and the invoice. Written by the branding upload endpoint, never typed — the settings API accepts only an empty value here, which clears it.',
    is_public: true,
  },
  {
    key: 'organisation.logo_mark',
    value: '',
    value_type: SettingValueType.STRING,
    group: 'organisation',
    description:
      'Storage key of the square mark (icon without the wordmark), used where the full logo will not fit: the favicon, the collapsed sidebar, an email avatar. Same upload path as organisation.logo.',
    is_public: true,
  },
  {
    key: 'billing.invoice_prefix',
    value: 'IN',
    value_type: SettingValueType.STRING,
    group: 'billing',
    description:
      'Leading token of every invoice number — IN in IN202603001 (OQ-8, answered 2026-08-13). Changing it starts a NEW sequence: numbers already issued keep the old prefix, and the new series restarts at 001 for the current quarter.',
    is_public: false,
  },
  {
    key: 'billing.invoice_footer',
    value: '',
    value_type: SettingValueType.STRING,
    group: 'billing',
    description:
      'Free text printed at the foot of every invoice — bank details, payment terms, a declaration. Multi-line; blank prints nothing.',
    is_public: false,
  },
  {
    key: 'billing.renewal_basis',
    value: 'term',
    value_type: SettingValueType.STRING,
    group: 'billing',
    description:
      "How a membership term is dated. 'term' runs the fee's duration_months from the join date (1 Aug 2026 + 12 = 31 Jul 2027). 'financial_year' ends every term on 31 March and charges the remaining months pro-rata, so all members renew together. DEFAULTS TO 'term' because that is what the platform did before this setting existed — an upgrade must not silently re-date live memberships.",
    is_public: false,
  },
  {
    key: 'billing.charge_application_fee',
    value: 'false',
    value_type: SettingValueType.BOOLEAN,
    group: 'billing',
    description:
      'Whether a one-time application fee is added to the first membership invoice, raised at APPROVAL alongside the membership fee (user decision, 2026-08-20). Charging at submission time is not supported: an invoice requires a Member row, and an applicant has none until approved.',
    is_public: false,
  },
  {
    key: 'billing.application_fee_amount',
    value: '0',
    value_type: SettingValueType.NUMBER,
    group: 'billing',
    description:
      'The application fee, in the fee currency, before tax. One amount for every category (user decision, 2026-08-21) — if it ever varies by category it belongs in FeeStructures, not here. Ignored while billing.charge_application_fee is false.',
    is_public: false,
  },
  {
    key: 'directory.public_enabled',
    value: 'false',
    value_type: SettingValueType.BOOLEAN,
    group: 'directory',
    description:
      'Whether the member directory is visible to unauthenticated visitors. FALSE until OQ-7 is answered — defaulting a directory of member firms to public is not a decision this seed may make.',
    is_public: true,
  },
];

export const seedSystemSettings = async (prisma: PrismaClient): Promise<number> => {
  for (const setting of SETTINGS) {
    await prisma.systemSetting.upsert({
      where: { key: setting.key },
      // `value` is intentionally NOT updated: re-seeding must never revert a
      // change an admin made deliberately in a live environment.
      update: {
        value_type: setting.value_type,
        group: setting.group,
        description: setting.description,
        is_public: setting.is_public,
      },
      create: setting,
    });
  }

  return SETTINGS.length;
};
