import { describe, expect, it } from 'vitest';
import { buildReportFilename } from '@modules/report/report.service';

const base = {
  report_type: 'members',
  createdAt: '2026-09-02T09:14:00.000Z',
};

describe('buildReportFilename', () => {
  /*
    A downloads folder holding six files called `members-2026-09-02.xlsx` is
    useless. The filters are the only thing that tells them apart, which is the
    whole reason they are recorded — and the filename is the first place that
    has to hold.
  */
  it('puts the filter names in the filename', () => {
    const name = buildReportFilename({
      ...base,
      filters: {
        status: [{ id: 'ACTIVE', name: 'Active' }],
        category_id: [{ id: '3', name: 'Gold' }],
      },
    });

    expect(name).toBe('members-active-gold-2026-09-02.xlsx');
  });

  it('falls back to the type and date when nothing was filtered', () => {
    expect(buildReportFilename({ ...base, filters: {} })).toBe('members-2026-09-02.xlsx');
  });

  /* A name long enough to be refused by a filesystem is a download that
     silently fails, so it is trimmed rather than left to chance. */
  it('trims a very long name without leaving a trailing dash', () => {
    const name = buildReportFilename({
      ...base,
      filters: {
        city: Array.from({ length: 40 }, (_, i) => ({
          id: String(i),
          name: `Very Long City Name ${i}`,
        })),
      },
    });

    expect(name.length).toBeLessThanOrEqual(120);
    expect(name).toMatch(/[a-z0-9]-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  /* A company name is not a filename. Punctuation and spacing must not reach
     the filesystem. */
  it('slugs a company name that is full of punctuation', () => {
    const name = buildReportFilename({
      ...base,
      filters: { member_id: [{ id: '1', name: 'ABC Textiles Pvt. Ltd. (Surat)' }] },
    });

    expect(name).toBe('members-abc-textiles-pvt-ltd-surat-2026-09-02.xlsx');
  });
});
