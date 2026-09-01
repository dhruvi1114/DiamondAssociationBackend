import { describe, expect, it } from 'vitest';

import { presentCard } from '@modules/directory/directory.presenter';
import type { DirectoryRow } from '@modules/directory/directory.types';

/** Deliberately fatter than DirectoryRow — see directory.leak.test.ts. */
const row = {
  id: 42n,
  company_name: 'Shreeji Exports Pvt Ltd',
  legal_name: 'Shreeji Overseas Trading Pvt Ltd',
  member_code: 'LGDGF/2026/0042',
  about: 'Exporters since 1998.',
  website: 'https://shreejiexports.in',
  logo_path: 'members/42/logo.png',
  joined_on: new Date('1998-04-01T00:00:00Z'),
  gst_number: '24AABCS1234F1Z5',
  pan_number: 'AABCS1234F',
  iec_code: '0398012345',
  trade_license_no: 'TL-99',
  addresses: [{ city: 'Surat', state: 'Gujarat', pincode: '380009' }],
  categories: [{ category: { name: 'Diamond Exporter' } }],
  contacts: [{ name: 'A', designation: null, email: 'a@b.c', phone: '98250' }],
} as unknown as DirectoryRow;

/**
 * The card now carries the year and the website.
 *
 * Neither is a new disclosure: both are already on the profile, to the same
 * audience, behind the same gate. What must not change is everything the card
 * has always refused to publish — so this asserts the additions *and* the
 * refusals in one place, because a presenter that gains a field is exactly when
 * a private one slips in beside it.
 */
describe('presentCard', () => {
  it('carries the joining year as a year, not a date', () => {
    expect(presentCard(row).joinedYear).toBe(1998);
  });

  it('says null rather than 1970 when a member has never been activated', () => {
    expect(presentCard({ ...row, joined_on: null } as DirectoryRow).joinedYear).toBeNull();
  });

  it('carries the website', () => {
    expect(presentCard(row).website).toBe('https://shreejiexports.in');
  });

  it.each([
    ['GST number', '24AABCS1234F1Z5'],
    ['PAN number', 'AABCS1234F'],
    ['IEC code', '0398012345'],
    ['trade licence', 'TL-99'],
    ['registered legal name', 'Shreeji Overseas'],
    ['pincode', '380009'],
    ['storage path', 'members/42/logo.png'],
    ['contact phone', '98250'],
  ])('still refuses to publish the %s', (_label, secret) => {
    expect(JSON.stringify(presentCard(row))).not.toContain(secret);
  });

  it('still addresses the logo through the gated route', () => {
    expect(presentCard(row).logoUrl).toBe('/api/v1/directory/media/42');
    expect(presentCard(row).logoUrl).not.toContain('/public/');
  });
});
