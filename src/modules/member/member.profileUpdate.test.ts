import { describe, expect, it } from 'vitest';
import { updateProfileSchema } from '@modules/member/member.types';

describe('updateProfileSchema (profile Company tab)', () => {
  const full = {
    company_name: 'Shah Diamonds LLP',
    company_type_id: '2',
    category_ids: ['3'],
    mobile: '9825012345',
    landline: '0261-2345678',
    pan_number: 'ABCDE1234F',
    gstin_holder: true,
    gst_number: '24ABCDE1234F1Z5',
    iec_code: 'ABCDE12345',
    trade_license_no: 'TL/2026/0042',
    website: 'https://shah.example',
    about: 'Growers since 1998.',
  };

  it('accepts every field the form sends', () => {
    expect(updateProfileSchema.safeParse(full).success).toBe(true);
  });

  it('refuses a mobile that is not ten digits', () => {
    expect(updateProfileSchema.safeParse({ ...full, mobile: '98250 12345' }).success).toBe(false);
  });

  it('refuses a malformed PAN, GSTIN or IEC', () => {
    expect(updateProfileSchema.safeParse({ ...full, pan_number: 'ABC123' }).success).toBe(false);
    expect(updateProfileSchema.safeParse({ ...full, gst_number: '24ABC' }).success).toBe(false);
    expect(updateProfileSchema.safeParse({ ...full, iec_code: 'abc' }).success).toBe(false);
  });

  it('asks a GSTIN holder for the number', () => {
    const result = updateProfileSchema.safeParse({ ...full, gst_number: null });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['gst_number']);
  });

  it('lets a non-holder leave the GSTIN empty', () => {
    expect(
      updateProfileSchema.safeParse({ ...full, gstin_holder: false, gst_number: null }).success,
    ).toBe(true);
  });
});
