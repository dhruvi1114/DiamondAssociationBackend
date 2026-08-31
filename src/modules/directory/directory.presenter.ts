import { API_V1, END_POINTS } from '@constant';

import type {
  DirectoryCard,
  DirectoryProfile,
  DirectoryRow,
} from '@modules/directory/directory.types';

/**
 * What a member is allowed to see of another member.
 *
 * One allowlist, because only an ACTIVE member ever reaches this file — there
 * is no anonymous audience to hold a second, narrower list for. An explicit
 * allowlist rather than "the row minus a few fields": the difference shows the
 * next time a column is added to `Members`, which an allowlist leaves out until
 * somebody decides otherwise, and a denylist ships by default.
 *
 * Absent by design, not by accident: `gst_number`, `pan_number`, `iec_code`,
 * `trade_license_no`, every `MemberDocument`, the pincode and the street lines,
 * and `legal_name` — which is searched but never shown, because publishing a
 * company under two names invites impersonation and adds nothing to the card.
 */

/** `<words>-<id>`. The id is the identity; the words are for the reader. */
export const directorySlug = (row: Pick<DirectoryRow, 'id' | 'company_name'>): string => {
  const words = row.company_name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');

  return `${words || 'member'}-${row.id}`;
};

/**
 * The id a slug addresses. `null` when the slug carries none.
 *
 * Reading the id rather than matching the words is what keeps a shared link
 * working after a company renames itself.
 */
export const idFromSlug = (slug: string): bigint | null => {
  const match = /-(\d+)$/.exec(slug);

  return match ? BigInt(match[1]) : null;
};

/**
 * The logo's address — gated like everything else here.
 *
 * Keyed off the directory router, not the public one. A public logo URL would
 * disclose that a given company is a member of this association, and could be
 * shared past the wall by anyone who had it.
 */
const logoUrl = (row: DirectoryRow): string | null =>
  row.logo_path ? `${API_V1}${END_POINTS.DIRECTORY}/media/${row.id}` : null;

export const presentCard = (row: DirectoryRow): DirectoryCard => ({
  slug: directorySlug(row),
  companyName: row.company_name,
  city: row.addresses[0]?.city ?? null,
  state: row.addresses[0]?.state ?? null,
  categories: row.categories.map((link) => link.category.name),
  logoUrl: logoUrl(row),
});

export const presentProfile = (row: DirectoryRow): DirectoryProfile => {
  const contact = row.contacts[0] ?? null;

  return {
    ...presentCard(row),
    memberCode: row.member_code,
    /* The year, not the date. "Member since 2026" is the useful signal. */
    joinedYear: row.joined_on ? row.joined_on.getUTCFullYear() : null,
    website: row.website,
    about: row.about,
    contact: contact
      ? {
          name: contact.name,
          designation: contact.designation,
          email: contact.email,
          phone: contact.phone,
        }
      : null,
  };
};
