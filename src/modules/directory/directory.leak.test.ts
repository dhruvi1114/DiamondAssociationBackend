import { describe, expect, it } from 'vitest';

import {
  directorySlug,
  idFromSlug,
  presentCard,
  presentProfile,
} from '@modules/directory/directory.presenter';
import type { DirectoryRow } from '@modules/directory/directory.types';

/**
 * A row deliberately fatter than `DirectoryRow`.
 *
 * Feeding the presenter every field that must never be published proves it
 * *selects*, rather than proving the repository happened not to fetch. The two
 * defences are independent on purpose: if a future change widens the query,
 * these tests still fail.
 */
const row = {
  id: 42n,
  company_name: 'Shreeji Exports Pvt Ltd',
  legal_name: 'Shreeji Overseas Trading Pvt Ltd',
  member_code: 'LGDGF/2026/0042',
  about: 'Spice and agri-commodity exporters since 1998.',
  website: 'https://shreejiexports.in',
  logo_path: 'members/42/logo.png',
  joined_on: new Date('2026-04-01T00:00:00Z'),
  gst_number: '24AABCS1234F1Z5',
  pan_number: 'AABCS1234F',
  iec_code: '0398012345',
  trade_license_no: 'TL-99',
  addresses: [
    {
      line1: '12 Relief Road',
      line2: 'Lal Darwaja',
      city: 'Ahmedabad',
      state: 'Gujarat',
      country: 'India',
      pincode: '380009',
    },
  ],
  contacts: [
    {
      name: 'Rakesh Patel',
      designation: 'Director',
      email: 'rakesh@shreejiexports.in',
      phone: '+91 98250 12345',
      is_primary: true,
    },
    {
      name: 'Meena Shah',
      designation: 'Sales Manager',
      email: 'meena@shreejiexports.in',
      phone: '+91 98250 99999',
      is_primary: false,
    },
  ],
  company_type: { name: 'Trader' },
  categories: [{ category: { name: 'Spices' } }, { category: { name: 'Agri Commodities' } }],
} as unknown as DirectoryRow;

describe('directory presenter', () => {
  /*
    The allowlist, widened by decision D-6: the registered address, the country,
    the company type and every published contact. The test still pins the exact
    key set, which is the point of it — a field reaches the profile by being
    added to this list, not by appearing in a presenter.
  */
  it('returns exactly the allowlisted profile keys', () => {
    expect(Object.keys(presentProfile(row)).sort()).toEqual(
      [
        'about',
        'address',
        'categories',
        'city',
        'companyName',
        'companyType',
        'contact',
        'contacts',
        'country',
        'joinedYear',
        'logoUrl',
        'memberCode',
        'slug',
        'state',
        'website',
      ].sort(),
    );
  });

  it.each([
    ['GST number', '24AABCS1234F1Z5'],
    ['PAN number', 'AABCS1234F'],
    ['IEC code', '0398012345'],
    ['trade licence', 'TL-99'],
    ['registered legal name', 'Shreeji Overseas'],
    ['storage path', 'members/42/logo.png'],
  ])('never publishes the %s', (_label, secret) => {
    expect(JSON.stringify(presentProfile(row))).not.toContain(secret);
    expect(JSON.stringify(presentCard(row))).not.toContain(secret);
  });

  /*
    The street address moved from "never" to "on the profile" (D-6). It is still
    off the card: the card is the search result, and a listing that carried
    every member's door would be the scrape this module is arranged to prevent.
  */
  it('publishes the registered address on the profile and not on the card', () => {
    expect(presentProfile(row).address?.pincode).toBe('380009');
    expect(presentProfile(row).address?.line1).toBe('12 Relief Road');
    expect(JSON.stringify(presentCard(row))).not.toContain('380009');
    expect(JSON.stringify(presentCard(row))).not.toContain('Relief Road');
  });

  it('formats the address as one line, ready to render', () => {
    expect(presentProfile(row).address?.formatted).toContain('12 Relief Road');
    expect(presentProfile(row).address?.formatted).toContain('380009');
  });

  /* Every contact, primary first — and the primary repeated for callers that
     only want the front door. */
  it('publishes every contact, with the primary marked and leading', () => {
    const profile = presentProfile(row);

    expect(profile.contacts).toHaveLength(2);
    expect(profile.contacts[0]?.isPrimary).toBe(true);
    expect(profile.contact?.name).toBe('Rakesh Patel');
    expect(profile.contacts[1]?.name).toBe('Meena Shah');
  });

  it('keeps every contact off the card, not just the primary', () => {
    expect(JSON.stringify(presentCard(row))).not.toContain('Meena Shah');
    expect(JSON.stringify(presentCard(row))).not.toContain('98250 99999');
  });

  /*
    The card is the search result; the profile is the page you opened on
    purpose. A phone number on every card would make the listing itself the
    scrape, which is the thing the whole module is arranged to prevent.
  */
  it('keeps contact details off the card, and on the profile', () => {
    expect(JSON.stringify(presentCard(row))).not.toContain('98250');
    expect(presentProfile(row).contact?.phone).toBe('+91 98250 12345');
  });

  it('publishes the joining year, not the date', () => {
    expect(presentProfile(row).joinedYear).toBe(2026);
    expect(JSON.stringify(presentProfile(row))).not.toContain('2026-04-01');
  });

  it('serves the logo through the gated directory route, never the public one', () => {
    expect(presentCard(row).logoUrl).toBe('/api/v1/directory/media/42');
    expect(presentCard(row).logoUrl).not.toContain('/public/');
  });

  it('gives a member with no logo a null rather than a broken URL', () => {
    expect(presentCard({ ...row, logo_path: null }).logoUrl).toBeNull();
  });

  it('round-trips a slug back to its id', () => {
    const slug = directorySlug(row);

    expect(slug).toBe('shreeji-exports-pvt-ltd-42');
    expect(idFromSlug(slug)).toBe(42n);
  });

  it('reads the id from a stale slug, so a renamed company keeps its links', () => {
    expect(idFromSlug('whatever-the-old-name-was-42')).toBe(42n);
  });

  it('refuses a slug that carries no id', () => {
    expect(idFromSlug('shreeji-exports')).toBeNull();
  });

  it('survives a company name that is entirely punctuation', () => {
    expect(directorySlug({ id: 7n, company_name: '!!! ???' })).toBe('member-7');
  });

  it('handles a member with no address, contact or category', () => {
    const bare = { ...row, addresses: [], contacts: [], categories: [] } as DirectoryRow;

    expect(presentProfile(bare)).toMatchObject({
      city: null,
      state: null,
      categories: [],
      contact: null,
    });
  });
});
