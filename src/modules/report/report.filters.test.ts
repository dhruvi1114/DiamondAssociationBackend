import { describe, expect, it } from 'vitest';
import { REPORT_FILTER_KEYS, toRepoParams } from '@modules/report/report.types';

describe('REPORT_FILTER_KEYS', () => {
  it('gives every report exactly the filters it reads', () => {
    expect(REPORT_FILTER_KEYS.members).toEqual([
      'status',
      'category_id',
      'city',
      'state',
      'member_id',
    ]);
    expect(REPORT_FILTER_KEYS.revenue).toEqual(['invoice_type', 'member_id']);
    expect(REPORT_FILTER_KEYS.renewals).toEqual(['status', 'member_id']);
    expect(REPORT_FILTER_KEYS.events).toEqual(['event_id']);
  });

  /*
    Events narrows by event, not by member: "which events did this member
    attend" is a different report from "how did these events do", and offering
    the filter would promise the first while running the second.
  */
  it('does not offer a member filter on the events report', () => {
    expect(REPORT_FILTER_KEYS.events).not.toContain('member_id');
  });
});

describe('toRepoParams', () => {
  it('turns stored refs into the id lists the queries take', () => {
    const params = toRepoParams('members', {
      status: [{ id: 'ACTIVE', name: 'Active' }],
      member_id: [
        { id: '142', name: 'ABC Textiles' },
        { id: '87', name: 'XYZ Exports' },
      ],
    });

    expect(params.statuses).toEqual(['ACTIVE']);
    expect(params.memberIds).toEqual(['142', '87']);
  });

  /* An empty selection is no filter at all, never "match nothing". */
  it('drops an empty selection rather than sending an empty list', () => {
    const params = toRepoParams('members', { status: [] });

    expect(params.statuses).toBeUndefined();
  });

  it('maps the event filter for the events report', () => {
    const params = toRepoParams('events', { event_id: [{ id: '7', name: 'Diwali Meet' }] });

    expect(params.eventIds).toEqual(['7']);
  });

  it('carries the date range through', () => {
    const params = toRepoParams('revenue', {}, '2026-08-01', '2026-08-31');

    expect(params.from).toBe('2026-08-01');
    expect(params.to).toBe('2026-08-31');
  });
});
