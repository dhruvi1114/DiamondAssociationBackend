import { describe, expect, it } from 'vitest';
import {
  isSatisfied,
  missingSides,
  requiredSides,
  sideForUpload,
  SIDE_LABELS,
} from '@modules/document/document.sides';

describe('requiredSides', () => {
  it('asks for one unnamed file for a single-sided type', () => {
    expect(requiredSides('SINGLE')).toEqual(['SINGLE']);
  });

  it('asks for a front and a back for a two-sided type', () => {
    expect(requiredSides('FRONT_AND_BACK')).toEqual(['FRONT', 'BACK']);
  });
});

describe('isSatisfied', () => {
  it('is unsatisfied when a single-sided type has nothing', () => {
    expect(isSatisfied('SINGLE', [])).toBe(false);
  });

  it('is satisfied when a single-sided type has its file', () => {
    expect(isSatisfied('SINGLE', ['SINGLE'])).toBe(true);
  });

  it('is unsatisfied when only the front of a two-sided type is present', () => {
    expect(isSatisfied('FRONT_AND_BACK', ['FRONT'])).toBe(false);
  });

  it('is unsatisfied when only the back of a two-sided type is present', () => {
    expect(isSatisfied('FRONT_AND_BACK', ['BACK'])).toBe(false);
  });

  it('is satisfied when both faces of a two-sided type are present', () => {
    expect(isSatisfied('FRONT_AND_BACK', ['BACK', 'FRONT'])).toBe(true);
  });

  it('accepts one combined PDF as both faces', () => {
    expect(isSatisfied('FRONT_AND_BACK', ['COMBINED'])).toBe(true);
  });

  it('ignores a combined file on a single-sided type', () => {
    expect(isSatisfied('SINGLE', ['COMBINED'])).toBe(false);
  });
});

describe('missingSides', () => {
  it('names the face that is missing', () => {
    expect(missingSides('FRONT_AND_BACK', ['FRONT'])).toEqual(['BACK']);
  });

  it('names nothing when a combined PDF covers both', () => {
    expect(missingSides('FRONT_AND_BACK', ['COMBINED'])).toEqual([]);
  });

  it('names the single file when nothing is uploaded', () => {
    expect(missingSides('SINGLE', [])).toEqual(['SINGLE']);
  });
});

describe('sideForUpload', () => {
  it('stores a single-sided upload as SINGLE whatever the caller asked for', () => {
    expect(sideForUpload('SINGLE', 'FRONT', 'image/jpeg')).toBe('SINGLE');
  });

  it('stores a PDF for a two-sided type as COMBINED', () => {
    expect(sideForUpload('FRONT_AND_BACK', 'FRONT', 'application/pdf')).toBe('COMBINED');
  });

  it('stores an image for a two-sided type as the face requested', () => {
    expect(sideForUpload('FRONT_AND_BACK', 'BACK', 'image/png')).toBe('BACK');
  });

  it('defaults a two-sided image upload with no face named to FRONT', () => {
    expect(sideForUpload('FRONT_AND_BACK', undefined, 'image/png')).toBe('FRONT');
  });
});

describe('SIDE_LABELS', () => {
  it('gives a two-sided face a name a member would recognise', () => {
    expect(SIDE_LABELS.BACK).toBe('back');
  });

  it('gives a single file no qualifier', () => {
    expect(SIDE_LABELS.SINGLE).toBe('');
  });
});
