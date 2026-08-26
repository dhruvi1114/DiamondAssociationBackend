import { describe, expect, it } from 'vitest';
import { checkCompleteness } from '@modules/application/approval.engine';

const type = (
  over: Partial<{
    code: string;
    name: string;
    sides: 'SINGLE' | 'FRONT_AND_BACK';
    is_required: boolean;
  }> = {},
) => ({
  id: 1n,
  code: 'PAN_DOCUMENT',
  name: 'PAN Document',
  description: null,
  is_required: true,
  sides: 'SINGLE' as const,
  max_size_mb: 10,
  allowed_mime: ['application/pdf'],
  display_order: 1,
  ...over,
});

const APPLICATION = { company_name: 'Acme Exports', category_id: 3n };

describe('checkCompleteness', () => {
  it('is complete when the single required document is supplied', () => {
    const result = checkCompleteness(
      APPLICATION,
      [type()],
      [{ code: 'PAN_DOCUMENT', side: 'SINGLE' }],
    );

    expect(result.complete).toBe(true);
    expect(result.missingDocuments).toEqual([]);
  });

  it('names an entirely missing document', () => {
    const result = checkCompleteness(APPLICATION, [type()], []);

    expect(result.complete).toBe(false);
    expect(result.missingDocuments).toEqual([
      { code: 'PAN_DOCUMENT', name: 'PAN Document', side: 'SINGLE', label: 'PAN Document' },
    ]);
  });

  it('names only the missing face of a two-sided document', () => {
    const aadhaar = type({ code: 'AADHAAR_CARD', name: 'Aadhaar Card', sides: 'FRONT_AND_BACK' });
    const result = checkCompleteness(
      APPLICATION,
      [aadhaar],
      [{ code: 'AADHAAR_CARD', side: 'FRONT' }],
    );

    expect(result.missingDocuments).toEqual([
      { code: 'AADHAAR_CARD', name: 'Aadhaar Card', side: 'BACK', label: 'Aadhaar Card (back)' },
    ]);
  });

  it('accepts a combined PDF for a two-sided document', () => {
    const aadhaar = type({ code: 'AADHAAR_CARD', name: 'Aadhaar Card', sides: 'FRONT_AND_BACK' });
    const result = checkCompleteness(
      APPLICATION,
      [aadhaar],
      [{ code: 'AADHAAR_CARD', side: 'COMBINED' }],
    );

    expect(result.complete).toBe(true);
  });

  it('never blocks on an optional document', () => {
    const cheque = type({ code: 'CANCELLED_CHEQUE', is_required: false });
    const result = checkCompleteness(APPLICATION, [cheque], []);

    expect(result.complete).toBe(true);
    expect(result.missingDocuments).toEqual([]);
  });

  it('still reports missing fields alongside missing documents', () => {
    const result = checkCompleteness({ company_name: '', category_id: null }, [type()], []);

    expect(result.missingFields).toEqual(['company_name', 'category_id']);
    expect(result.missingDocuments).toHaveLength(1);
  });
});
