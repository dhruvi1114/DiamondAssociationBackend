import { describe, expect, it } from 'vitest';
import { generateReportSchema } from '@modules/report/report.types';
import { summarise } from '@modules/report/report.service';

describe('generateReportSchema', () => {
  const base = { report_type: 'members', report_name: 'AGM list' };

  it('accepts a filter the report actually reads', () => {
    const parsed = generateReportSchema.safeParse({
      ...base,
      filters: { status: [{ id: 'ACTIVE', name: 'Active' }] },
    });

    expect(parsed.success).toBe(true);
  });

  /*
    Accepting a filter the query ignores would record a narrowing that never
    happened: the sheet's caption would claim it and the numbers would not show
    it, which is the one way a report can lie without being wrong.
  */
  it('rejects a filter that report does not read', () => {
    const parsed = generateReportSchema.safeParse({
      ...base,
      filters: { invoice_type: [{ id: 'EVENT', name: 'Event' }] },
    });

    expect(parsed.success).toBe(false);
  });

  it('requires a name', () => {
    expect(generateReportSchema.safeParse({ report_type: 'members' }).success).toBe(false);
  });

  it('defaults include_details to false', () => {
    const parsed = generateReportSchema.parse(base);

    expect(parsed.include_details).toBe(false);
  });

  /* A ref without its display name defeats the point of storing filters. */
  it('rejects a filter ref that has no name', () => {
    const parsed = generateReportSchema.safeParse({
      ...base,
      filters: { status: [{ id: 'ACTIVE' }] },
    });

    expect(parsed.success).toBe(false);
  });
});

describe('summarise', () => {
  it('counts the members', () => {
    const figures = summarise('members', [
      { member_code: 'A', status: 'ACTIVE' },
      { member_code: 'B', status: 'DRAFT' },
    ]);

    expect(figures['Total Members']).toBe(2);
  });

  /* Money arrives as a string; the figures must still be numbers Excel totals. */
  it('totals the revenue columns', () => {
    const figures = summarise('revenue', [
      {
        period: '2026-08',
        invoices: 5,
        billed: '73800',
        collected: '50200',
        outstanding: '23600',
      },
    ]);

    expect(figures['Total Billed']).toBe(73800);
    expect(figures['Total Collected']).toBe(50200);
    expect(figures['Total Outstanding']).toBe(23600);
  });

  /* The two rows the renewals report exists to surface, called out rather than
     left to be counted by eye down a column of dates. */
  it('counts lapsed and soon-due terms separately', () => {
    const figures = summarise('renewals', [
      { days_remaining: -12 },
      { days_remaining: 14 },
      { days_remaining: 900 },
    ]);

    expect(figures['Already Lapsed']).toBe(1);
    expect(figures['Due Within 30 Days']).toBe(1);
    expect(figures['Total Terms']).toBe(3);
  });

  it('totals bookings, attendees and revenue for events', () => {
    const figures = summarise('events', [
      { registrations: 3, attendees: 3, revenue: '3000' },
      { registrations: 3, attendees: 4, revenue: '6000' },
    ]);

    expect(figures['Total Bookings']).toBe(6);
    expect(figures['Total Attendees']).toBe(7);
    expect(figures['Total Revenue']).toBe(9000);
  });

  /* An empty report is a real answer — zero, not a crash and not a blank. */
  it('answers zero for a report that matched nothing', () => {
    expect(summarise('events', [])['Total Attendees']).toBe(0);
    expect(summarise('members', [])['Total Members']).toBe(0);
  });
});
