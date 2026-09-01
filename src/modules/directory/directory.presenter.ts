import { API_V1, END_POINTS } from '@constant';

import type {
  DirectoryCard,
  DirectoryContact,
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
  /*
    The year and the website ride on the card as well as the profile. Neither
    is a new disclosure — both are already published one click away, to the same
    audience, and the card is behind the same gate the profile is. What they buy
    is a reader deciding from the list instead of opening six profiles to find
    the exporter who has been a member since the eighties.
  */
  joinedYear: row.joined_on ? row.joined_on.getUTCFullYear() : null,
  website: row.website,
});

/** One contact, as the profile publishes it. */
const contactOf = (row: DirectoryRow['contacts'][number]): DirectoryContact => ({
  name: row.name,
  designation: row.designation,
  email: row.email,
  phone: row.phone,
  isPrimary: row.is_primary,
});

/**
 * The registered address, street lines included (D-6).
 *
 * `formatted` is built here rather than in the client: an address is written
 * differently in different countries, and the rule for it belongs next to the
 * data rather than in whichever screen happens to render it first.
 */
const addressOf = (row: DirectoryRow): DirectoryProfile['address'] => {
  const address = row.addresses[0];

  if (!address) return null;

  const formatted = [
    address.line1,
    address.line2,
    [address.city, address.state].filter(Boolean).join(', '),
    [address.pincode, address.country].filter(Boolean).join(', '),
  ]
    .filter(Boolean)
    .join(', ');

  return { ...address, formatted };
};

export const presentProfile = (row: DirectoryRow): DirectoryProfile => {
  const contacts = row.contacts.map(contactOf);
  const address = addressOf(row);

  return {
    ...presentCard(row),
    memberCode: row.member_code,
    about: row.about,
    companyType: row.company_type?.name ?? null,
    country: address?.country ?? null,
    address,
    contacts,
    /*
      The primary, repeated. The list is ordered primary-first, so this is its
      head — but a caller that wants the front door should not have to know
      that, and a company with no primary marked gets null rather than whoever
      happens to sort first.
    */
    contact: contacts.find((entry) => entry.isPrimary) ?? null,
  };
};
