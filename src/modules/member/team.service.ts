import { AUDIT_ACTIONS, ACTOR_TYPES } from '@constant/audit.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { prisma } from '@db/prisma';
import { writeAudit } from '@helpers/audit';
import { issueInitialPasswordLink } from '@modules/auth/auth.service';
import { MEMBER_ROLE, MEMBER_USER_STATUS } from '@modules/member/team.constants';
import * as repo from '@modules/member/team.repository';
import { AppError } from '@utils/appError';
import type { TeamMemberRow } from '@modules/member/team.repository';
import type { InviteTeamMemberInput } from '@modules/member/team.types';

/**
 * The company's team roster.
 *
 * BigInt ids become strings at this boundary: JSON has no bigint, and the
 * encryption layer stringifies the payload before any custom replacer would run.
 */
export const listTeam = async (memberId: bigint): Promise<TeamMemberRow[]> => {
  const rows = await repo.findTeamByMemberId(memberId);

  return rows.map((row) => ({
    ...row,
    id: row.id.toString(),
    user_id: row.user_id.toString(),
  }));
};

/** Who is asking, and on behalf of which company. */
export interface TeamContext {
  memberId: bigint;
  userId: bigint;
  isOwner: boolean;
}

/** The request metadata every audit row carries. */
export interface TeamRequestContext {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

/**
 * How long a team invite link stays usable.
 *
 * Matches the password-reset window it is built on: the link *is* a password
 * reset token, so a separate expiry here would be a second number that could
 * silently disagree with the one actually enforced.
 */
const INVITE_EXPIRY_HOURS = 48;

/**
 * Invite a colleague onto the company roster.
 *
 * The login is created without a password and the invitee sets one through the
 * existing `setInitialPassword` link. Reusing that path rather than inventing an
 * invite-token flow leaves one password-setting code path, one expiry rule and
 * one place a token could be replayed, instead of two of each.
 */
export const inviteTeamMember = async (
  input: InviteTeamMemberInput,
  context: TeamContext,
  request: TeamRequestContext,
) => {
  const existing = await repo.findUserByEmail(prisma, input.email);

  if (existing) {
    // Distinguish the two cases: "already on your team" is reassuring, "already
    // in use" tells the owner the address belongs somewhere else entirely. One
    // generic message would leave them retrying the same thing.
    const onThisTeam = await repo.findTeamRowByUserId(prisma, context.memberId, existing.id);

    throw new AppError({
      errorType: ERROR_TYPES.CONFLICT,
      messageKey: onThisTeam ? 'member.teamEmailAlreadyOnTeam' : 'member.teamEmailInUse',
    });
  }

  return prisma.$transaction(async (tx) => {
    const user = await repo.createUser(tx, {
      email: input.email,
      full_name: input.full_name,
    });

    const row = await repo.createTeamRow(tx, {
      member_id: context.memberId,
      user_id: user.id,
      member_role: MEMBER_ROLE.TEAM,
      status: MEMBER_USER_STATUS.INVITED,
      invited_by_user_id: context.userId,
      created_by_user_id: context.userId,
    });

    await repo.createInvite(tx, {
      member_id: context.memberId,
      user_id: user.id,
      email: input.email,
      full_name: input.full_name,
      designation: input.designation ?? null,
      invited_by_user_id: context.userId,
      expires_at: new Date(Date.now() + INVITE_EXPIRY_HOURS * 3_600_000),
      created_by_user_id: context.userId,
    });

    await issueInitialPasswordLink(tx, user, request);

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.MEMBER_TEAM_INVITED,
      entityName: 'MemberUsers',
      entityId: row.id,
      actorType: ACTOR_TYPES.MEMBER,
      actorId: context.userId,
      after: { email: input.email, member_role: MEMBER_ROLE.TEAM },
      ip: request.ip,
      userAgent: request.userAgent,
      requestId: request.requestId,
    });

    return {
      id: row.id.toString(),
      user_id: user.id.toString(),
      full_name: input.full_name,
      email: input.email,
      designation: input.designation ?? null,
      member_role: MEMBER_ROLE.TEAM,
      status: MEMBER_USER_STATUS.INVITED,
      accepted_at: null,
    };
  });
};
