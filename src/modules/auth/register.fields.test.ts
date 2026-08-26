import { describe, expect, it } from 'vitest';
import { parseUploadFieldName, uploadFieldName } from '@modules/auth/register.constants';

describe('uploadFieldName', () => {
  it('names a single-sided upload', () => {
    expect(uploadFieldName('PAN_DOCUMENT', 'SINGLE')).toBe('document__PAN_DOCUMENT__SINGLE');
  });

  it('names each face of a two-sided upload distinctly', () => {
    expect(uploadFieldName('AADHAAR_CARD', 'FRONT')).toBe('document__AADHAAR_CARD__FRONT');
    expect(uploadFieldName('AADHAAR_CARD', 'BACK')).toBe('document__AADHAAR_CARD__BACK');
  });
});

describe('parseUploadFieldName', () => {
  it('round-trips', () => {
    expect(parseUploadFieldName(uploadFieldName('AADHAAR_CARD', 'BACK'))).toEqual({
      code: 'AADHAAR_CARD',
      side: 'BACK',
    });
  });

  it('round-trips a code that itself contains an underscore', () => {
    expect(parseUploadFieldName(uploadFieldName('GST_CERTIFICATE', 'SINGLE'))).toEqual({
      code: 'GST_CERTIFICATE',
      side: 'SINGLE',
    });
  });

  it('rejects a field that is not one of ours', () => {
    expect(parseUploadFieldName('avatar')).toBeNull();
  });

  it('rejects an unknown face', () => {
    expect(parseUploadFieldName('document__PAN_DOCUMENT__SIDEWAYS')).toBeNull();
  });

  it('rejects a code that is not a legal document code', () => {
    expect(parseUploadFieldName('document__../../etc/passwd__FRONT')).toBeNull();
  });
});
