import * as repo from '@modules/member/team.repository';
import type { Db } from '@db/prisma';

/**
 * Turn an accepted invite into a working team login.
 *
 * Called from `setInitialPassword` inside its existing transaction, so the
 * password and the roster row commit together. Split across two transactions, a
 * crash between them would leave someone able to sign in while still showing as
 * INVITED — or the reverse, listed as active with no way to log in.
 *
 * One timestamp for both writes, so the roster and the invite agree on when the
 * person joined.
 */
export const activateInvitedTeamRow = async (tx: Db, userId: bigint): Promise<void> => {
  const now = new Date();

  await repo.activateTeamRowForUser(tx, userId, now);
  await repo.acceptInvitesForUser(tx, userId, now);
};
