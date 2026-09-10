import { describe, expect, it } from 'vitest';
import { bookingsWhereForMember, invoicesWhereForMember } from '@modules/event/booking.linking';

describe('bookingsWhereForMember', () => {
  it("matches only the member's own bookings when nothing has been linked to them — the path that runs today", () => {
    expect(bookingsWhereForMember(42n, [])).toEqual({
      deletedAt: null,
      member_id: 42n,
    });
  });

  it("matches the member's own bookings and the guest bookings linked to them by id", () => {
    expect(bookingsWhereForMember(42n, [7n, 9n])).toEqual({
      deletedAt: null,
      OR: [{ member_id: 42n }, { guest_registrant_id: { in: [7n, 9n] } }],
    });
  });
});

describe('invoicesWhereForMember', () => {
  it("matches the member's own invoices and the guest invoices linked to them", () => {
    expect(invoicesWhereForMember(42n)).toEqual({
      deletedAt: null,
      OR: [{ member_id: 42n }, { guest_registrant: { linked_member_id: 42n } }],
    });
  });
});
