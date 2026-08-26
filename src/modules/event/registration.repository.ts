import { Prisma } from '@prisma/client';
import { EVENT_STATUS } from '@modules/event/event.constants';
import type { Db } from '@db/prisma';

/**
 * Seat accounting.
 *
 * The whole module exists to make one thing impossible: two people buying the
 * same last seat. That is not achievable by reading `seats_taken`, deciding, and
 * writing it back — between the read and the write another request does the
 * same, and both succeed.
 *
 * So the decision and the write are one statement, and the database is what
 * refuses. `CK seats_taken <= capacity` sits behind it as the backstop for any
 * future code path that writes the column another way.
 */

/**
 * Take `seats` for an event, or refuse.
 *
 * Returns the new total when the seats were taken, or `null` when they were not
 * — because the event is not published, no longer exists, or has fewer seats
 * left than asked for. `null` is an ordinary answer, not an error: the caller
 * rolls its transaction back and tells the booker *before* any invoice exists.
 */
export const takeSeats = async (db: Db, eventId: bigint, seats: number): Promise<number | null> => {
  const rows = await db.$queryRaw<{ seats_taken: number }[]>(Prisma.sql`
    UPDATE "Events"
       SET "seats_taken" = "seats_taken" + ${seats},
           "updatedAt" = now()
     WHERE "id" = ${eventId}
       AND "deletedAt" IS NULL
       AND "status" = ${EVENT_STATUS.PUBLISHED}
       AND ("capacity" IS NULL OR "seats_taken" + ${seats} <= "capacity")
    RETURNING "seats_taken"
  `);

  return rows[0]?.seats_taken ?? null;
};

/**
 * Give `seats` back — an expired hold, a cancellation, a refused approval.
 *
 * Guarded the same way so the counter can never go negative, which would let the
 * event oversell later by exactly the amount it went below zero. A release that
 * finds nothing to release returns null rather than throwing: the sweep job runs
 * over many rows and one already-released booking must not stop the rest.
 */
export const releaseSeats = async (
  db: Db,
  eventId: bigint,
  seats: number,
): Promise<number | null> => {
  const rows = await db.$queryRaw<{ seats_taken: number }[]>(Prisma.sql`
    UPDATE "Events"
       SET "seats_taken" = "seats_taken" - ${seats},
           "updatedAt" = now()
     WHERE "id" = ${eventId}
       AND "seats_taken" >= ${seats}
    RETURNING "seats_taken"
  `);

  return rows[0]?.seats_taken ?? null;
};
