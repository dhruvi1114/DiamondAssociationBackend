/**
 * Attach verified guest event bookings to the members who made them.
 *
 * Covers two backlogs: members activated before the linking step existed, and
 * members whose linking failed at set-password time — where the failure is
 * deliberately swallowed so it cannot undo a password (see
 * `attachBookingsAfterActivation`).
 *
 * Safe to re-run. `linkVerifiedGuestBookings` filters on `linked_member_id IS NULL`,
 * so a second pass over the same member writes nothing.
 *
 * It will NOT attach a booking whose `email_verified_at` is NULL, which is every
 * booking made before the OTP existed. That is the point, not an oversight — those
 * addresses were never proven, and attaching one could hang a stranger's unpaid
 * invoice on a real company.
 *
 *   npx tsx scripts/backfill-guest-booking-links.ts [--dry-run]
 */
import { PrismaClient, UserStatus } from '@prisma/client';
import { linkVerifiedGuestBookings } from '../src/modules/event/booking.linking';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');

const main = async (): Promise<void> => {
  const candidates = await prisma.user.findMany({
    where: {
      status: UserStatus.ACTIVE,
      deletedAt: null,
      // `Members.primary_user_id` is @unique, so this relation is a to-one. Filtering
      // `deletedAt: null` here too keeps this candidate set matching exactly what
      // `linkVerifiedGuestBookings` will accept — it re-checks `primary_user_id` with
      // `deletedAt: null` and returns 0 for a soft-deleted member, so these two filters
      // must agree or the dry run over-promises what the real run will do.
      member: { is: { deletedAt: null } },
    },
    select: { id: true, email: true },
    orderBy: { id: 'asc' },
  });

  console.log(`${candidates.length} active member login(s) to check${dryRun ? ' (dry run)' : ''}`);

  let linked = 0;
  let touched = 0;

  for (const user of candidates) {
    if (dryRun) {
      const pending = await prisma.guestRegistrant.count({
        where: { email: user.email, email_verified_at: { not: null }, linked_member_id: null },
      });

      if (pending > 0) {
        console.log(`  would link ${pending} booking(s) for user ${user.id}`);
        linked += pending;
        touched += 1;
      }

      continue;
    }

    const count = await linkVerifiedGuestBookings(prisma, user.id);

    if (count > 0) {
      console.log(`  linked ${count} booking(s) for user ${user.id}`);
      linked += count;
      touched += 1;
    }
  }

  console.log(`${linked} booking(s) across ${touched} member(s)`);
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
