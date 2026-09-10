import { UserStatus } from '@prisma/client';
import { logger } from '@logger/logger';
import type { Db } from '@db/prisma';

/**
 * Recognising a guest booking as a member's, after the fact.
 *
 * The match key is a VERIFIED email and nothing else (D-4). Company name and GSTIN
 * are deliberately not consulted: a typo in either merges two different companies,
 * and unmerging afterwards means deciding which invoices belonged to whom.
 *
 * Nothing here rewrites ownership. `EventRegistration` and `Invoice` both carry a
 * CHECK requiring exactly one of member/guest, and an invoice already issued must
 * keep the party it names — so the only write is `GuestRegistrant.linked_member_id`,
 * which the member's read paths follow.
 */

/** The member behind an ACTIVE login with this address, if there is one. */
export const memberIdForVerifiedEmail = async (db: Db, email: string): Promise<bigint | null> => {
  const user = await db.user.findFirst({
    where: { email, status: UserStatus.ACTIVE, deletedAt: null },
    select: { id: true },
  });

  if (!user) return null;

  const member = await db.member.findFirst({
    where: { primary_user_id: user.id, deletedAt: null },
    select: { id: true },
  });

  return member?.id ?? null;
};

/**
 * Attach every verified, unattached guest booking made with this user's address —
 * but only when this user IS their company's primary user.
 *
 * `Member.primary_user_id` is the only edge this walks. A team login (created by
 * `activateInvitedTeamRow` when a colleague accepts an invite) sits on the SAME
 * endpoint that calls this — `setInitialPassword` — but has no row where it is the
 * `primary_user_id`, so `member` below is null and this returns 0 without linking
 * anything.
 *
 * That is deliberate, not a gap this should grow a `MemberUser` lookup to close.
 * The design (`docs/superpowers/specs/2026-09-09-guest-booking-linking-design.md`,
 * "Attendee emails") matches on the *company* email only: a team member's login
 * address is a staff address, not the company's, and is explicitly not meant to
 * match. If a future spec change wants team logins to link too, that is a new
 * decision to make on purpose — not something to "fix" here because the miss looks
 * like a bug from the call site.
 *
 * Returns how many rows were attached. Idempotent: `linked_member_id: null` in the
 * filter means a second run over the same member writes nothing, which is what lets
 * the backfill be run as often as anyone likes.
 *
 * `email_verified_at: { not: null }` is the security boundary. Rows written before
 * this feature existed, and rows written while the switch was off, have NULL there
 * and are never attached — their addresses were never proven, and attaching one
 * would hang a stranger's booking, and its unpaid invoice, on a real company.
 */
export const linkVerifiedGuestBookings = async (db: Db, userId: bigint): Promise<number> => {
  const user = await db.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { email: true },
  });

  if (!user) return 0;

  const member = await db.member.findFirst({
    where: { primary_user_id: userId, deletedAt: null },
    select: { id: true },
  });

  if (!member) {
    // Not a gap in the query — the same "not the company's own login" case the
    // docstring above explains. Logged so this is distinguishable from "checked,
    // found nothing to link"; the email itself is never logged (personal data,
    // observability.md §3 — see auth.service.ts's signupOnExistingAccount).
    logger.info('event.guestBookingLinkSkipped', {
      userId: userId.toString(),
      reason: 'not_primary_user',
    });

    return 0;
  }

  const { count } = await db.guestRegistrant.updateMany({
    where: {
      email: user.email,
      email_verified_at: { not: null },
      linked_member_id: null,
    },
    data: { linked_member_id: member.id },
  });

  return count;
};

/**
 * What "mine" means on a member's own screens, once guest history can be linked.
 *
 * Built here, once, rather than written out at each call site: bookings and invoices
 * must agree about what belongs to a member, and two hand-written filters drift.
 *
 * The linked half reaches rows the member does NOT own — the CHECK constraint keeps
 * them guest-owned forever. This is a visibility join, and every read path that uses
 * it must treat those rows as read-only history.
 */

/**
 * The `GuestRegistrant` ids this member's verified history has been linked to.
 *
 * `EventRegistration.guest_registrant_id` has no Prisma relation (and no physical
 * FK — see `event.prisma`; only `event_id` and `invoice_id` carry one today, and
 * adding one for this column alone is a schema-integrity decision this read-path
 * feature must not make as a side effect). So `bookingsWhereForMember` cannot walk
 * a relation the way `invoicesWhereForMember` does through `Invoice.guest_registrant`
 * — it filters on the scalar column instead, and this is what supplies the ids for
 * that. `linked_member_id` is indexed, so this is a single indexed lookup.
 */
export const linkedGuestIdsForMember = async (db: Db, memberId: bigint): Promise<bigint[]> => {
  const rows = await db.guestRegistrant.findMany({
    where: { linked_member_id: memberId },
    select: { id: true },
  });

  return rows.map((row) => row.id);
};

/**
 * `linkedGuestIds` is empty for every member today (nothing has been linked yet).
 * Deliberately not an `OR` with `guest_registrant_id: { in: [] }` in that case: an
 * empty `IN ()` is an always-false predicate that still costs a clause, and this is
 * the path that runs in production right now, not the exceptional one.
 */
export const bookingsWhereForMember = (memberId: bigint, linkedGuestIds: bigint[]) =>
  linkedGuestIds.length === 0
    ? { deletedAt: null, member_id: memberId }
    : {
        deletedAt: null,
        OR: [{ member_id: memberId }, { guest_registrant_id: { in: linkedGuestIds } }],
      };

/**
 * `Invoice.guest_registrant` is a real Prisma relation (declared in
 * `application.prisma`), unlike `EventRegistration`'s scalar-only column above — so
 * this can walk it directly instead of needing the id list.
 */
export const invoicesWhereForMember = (memberId: bigint) => ({
  deletedAt: null,
  OR: [{ member_id: memberId }, { guest_registrant: { linked_member_id: memberId } }],
});
