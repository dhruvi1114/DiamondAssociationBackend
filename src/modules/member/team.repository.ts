import { Prisma, UserStatus } from '@prisma/client';
import { prisma } from '@db/prisma';
import type { Db } from '@db/prisma';
import { MEMBER_USER_STATUS } from '@modules/member/team.constants';

/**
 * Data access for company team logins.
 *
 * The roster is one raw statement joining `Users`, because the screen wants the
 * login's name and address beside the team row, and a nested Prisma include
 * returns a shape the controller then has to flatten anyway (ADR-005).
 */

export interface TeamMemberRow {
  id: string;
  user_id: string;
  full_name: string;
  email: string;
  designation: string | null;
  member_role: number;
  status: number;
  accepted_at: Date | null;
}

export interface TeamMemberDbRow extends Omit<TeamMemberRow, 'id' | 'user_id'> {
  id: bigint;
  user_id: bigint;
}

/**
 * The roster for one firm: owner first, then everyone else oldest to newest.
 *
 * `designation` is not on `MemberUsers` — it is whatever the owner typed on the
 * most recent invite, so it comes from a lateral join rather than being
 * duplicated onto the team row and left to drift.
 */
export const findTeamByMemberId = async (memberId: bigint): Promise<TeamMemberDbRow[]> =>
  prisma.$queryRaw<TeamMemberDbRow[]>(Prisma.sql`
    SELECT mu."id",
           mu."user_id",
           u."full_name",
           u."email"::text AS email,
           i."designation",
           mu."member_role",
           mu."status",
           mu."accepted_at"
      FROM "MemberUsers" mu
      JOIN "Users" u ON u."id" = mu."user_id"
      LEFT JOIN LATERAL (
        SELECT ti."designation"
          FROM "MemberTeamInvites" ti
         WHERE ti."user_id" = mu."user_id"
           AND ti."member_id" = mu."member_id"
         ORDER BY ti."createdAt" DESC
         LIMIT 1
      ) i ON TRUE
     WHERE mu."member_id" = ${memberId}
     ORDER BY mu."member_role" ASC, mu."id" ASC
  `);

/** One team row, scoped to the firm so a caller can never reach another company's. */
export const findTeamRow = (db: Db, memberId: bigint, id: bigint) =>
  db.memberUser.findFirst({ where: { id, member_id: memberId } });

/** Is this login already on this firm's roster, in any status? */
export const findTeamRowByUserId = (db: Db, memberId: bigint, userId: bigint) =>
  db.memberUser.findFirst({ where: { member_id: memberId, user_id: userId } });

/** Any login already using this address, across every company. */
export const findUserByEmail = (db: Db, email: string) =>
  db.user.findFirst({ where: { email, deletedAt: null } });

export const updateTeamRow = (
  db: Db,
  id: bigint,
  data: {
    status?: number;
    accepted_at?: Date | null;
    deactivated_at?: Date | null;
    updated_by_user_id?: bigint;
  },
) => db.memberUser.update({ where: { id }, data });

/**
 * Activate every INVITED row for this login.
 *
 * Scoped to INVITED so replaying an old link cannot resurrect someone an owner
 * deactivated, and written as `updateMany` so a login with no team row at all is
 * a no-op rather than a thrown "record not found".
 */
export const activateTeamRowForUser = (db: Db, userId: bigint, now: Date) =>
  db.memberUser.updateMany({
    where: { user_id: userId, status: MEMBER_USER_STATUS.INVITED },
    data: { status: MEMBER_USER_STATUS.ACTIVE, accepted_at: now },
  });

/** Mark this login's open invites accepted so they stop showing as pending. */
export const acceptInvitesForUser = (db: Db, userId: bigint, now: Date) =>
  db.memberTeamInvite.updateMany({
    where: { user_id: userId, accepted_at: null, revoked_at: null },
    data: { accepted_at: now },
  });

/**
 * A login with no password yet.
 *
 * `password_hash` stays null until the invitee follows the emailed link, and
 * `setInitialPassword` refuses to run against a login that already has one — so
 * an invite link cannot be replayed to overwrite a working password.
 */
export const createUser = (db: Db, data: { email: string; full_name: string }) =>
  db.user.create({
    data: {
      email: data.email,
      full_name: data.full_name,
      password_hash: null,
      status: UserStatus.PENDING_VERIFICATION,
    },
  });

export const createTeamRow = (
  db: Db,
  data: {
    member_id: bigint;
    user_id: bigint;
    member_role: number;
    status: number;
    invited_by_user_id: bigint;
    created_by_user_id: bigint;
  },
) => db.memberUser.create({ data });

export const createInvite = (
  db: Db,
  data: {
    member_id: bigint;
    user_id: bigint;
    email: string;
    full_name: string;
    designation: string | null;
    invited_by_user_id: bigint;
    expires_at: Date;
    created_by_user_id: bigint;
  },
) => db.memberTeamInvite.create({ data });
