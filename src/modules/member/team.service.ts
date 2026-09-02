import { AUDIT_ACTIONS, ACTOR_TYPES } from '@constant/audit.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { prisma } from '@db/prisma';
import { writeAudit } from '@helpers/audit';
import { issueInitialPasswordLink } from '@modules/auth/auth.service';
import { MEMBER_ROLE, MEMBER_USER_STATUS } from '@modules/member/team.constants';
import * as memberRepo from '@modules/member/member.repository';
import * as repo from '@modules/member/team.repository';
import { AppError } from '@utils/appError';
import type { TeamMemberRow } from '@modules/member/team.repository';
import type { TeamStatusInput } from '@modules/member/team.types';

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
 * Give an existing contact a login.
 *
 * The people list is `MemberContacts`: one row per person, holding the name,
 * job title, email and phone. Access is granted onto a person who is already
 * recorded, rather than by typing them a second time into a separate team form.
 * That is the whole point of the merge — an accountant who must receive
 * invoices and must never reach the portal is simply a contact nobody granted.
 *
 * The login itself is still a `MemberUsers` row. Members edit their contacts
 * freely, so the table that decides who may sign in is deliberately not the
 * table they edit.
 */
export const grantContactAccess = async (
  contactId: bigint,
  context: TeamContext,
  request: TeamRequestContext,
) => {
  const contact = await memberRepo.findContact(prisma, context.memberId, contactId);

  // Scoped to the caller's company, so another firm's contact is "not found"
  // rather than "forbidden" — a 403 would confirm the row exists.
  if (!contact) {
    throw new AppError({
      errorType: ERROR_TYPES.NOT_FOUND,
      messageKey: 'member.contactNotFound',
    });
  }

  if (contact.user_id) {
    throw new AppError({
      errorType: ERROR_TYPES.CONFLICT,
      messageKey: 'member.teamEmailAlreadyOnTeam',
    });
  }

  // An email is optional on a contact and mandatory for a login: it is both the
  // address the invitation goes to and the identifier they sign in with.
  if (!contact.email) {
    throw new AppError({
      errorType: ERROR_TYPES.VALIDATION_ERROR,
      messageKey: 'member.contactEmailRequiredForAccess',
    });
  }

  const email = contact.email.toLowerCase();
  const existing = await repo.findUserByEmail(prisma, email);

  if (existing) {
    const onThisTeam = await repo.findTeamRowByUserId(prisma, context.memberId, existing.id);

    throw new AppError({
      errorType: ERROR_TYPES.CONFLICT,
      messageKey: onThisTeam ? 'member.teamEmailAlreadyOnTeam' : 'member.teamEmailInUse',
    });
  }

  return prisma.$transaction(async (tx) => {
    const user = await repo.createUser(tx, { email, full_name: contact.name });

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
      email,
      full_name: contact.name,
      designation: contact.designation,
      invited_by_user_id: context.userId,
      expires_at: new Date(Date.now() + INVITE_EXPIRY_HOURS * 3_600_000),
      created_by_user_id: context.userId,
    });

    // The link that makes the two rows one person. Without it the next list
    // would show the contact and the login as two separate people again.
    await memberRepo.updateContact(tx, contact.id, { user: { connect: { id: user.id } } });

    await issueInitialPasswordLink(tx, user, request);

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.MEMBER_TEAM_INVITED,
      entityName: 'MemberUsers',
      entityId: row.id,
      actorType: ACTOR_TYPES.MEMBER,
      actorId: context.userId,
      after: { email, member_role: MEMBER_ROLE.TEAM, contact_id: contact.id.toString() },
      ip: request.ip,
      userAgent: request.userAgent,
      requestId: request.requestId,
    });

    return {
      id: contact.id.toString(),
      user_id: user.id.toString(),
      member_role: MEMBER_ROLE.TEAM,
      access_status: MEMBER_USER_STATUS.INVITED,
    };
  });
};

/**
 * Switch a contact's login on or off.
 *
 * Addressed by contact, like granting is, so the whole of a person's access is
 * managed from the one row that represents them. The owner is refused for the
 * same reason as ever: only ACTIVE rows resolve a login to its company, so
 * switching the owner off locks the firm out of its own account with no way
 * back from the member side.
 */
export const setContactAccess = async (
  contactId: bigint,
  input: TeamStatusInput,
  context: TeamContext,
  request: TeamRequestContext,
) => {
  const contact = await memberRepo.findContact(prisma, context.memberId, contactId);

  if (!contact?.user_id) {
    throw new AppError({
      errorType: ERROR_TYPES.NOT_FOUND,
      messageKey: 'member.contactNotFound',
    });
  }

  const row = await repo.findTeamRowByUserId(prisma, context.memberId, contact.user_id);

  if (!row) {
    throw new AppError({
      errorType: ERROR_TYPES.NOT_FOUND,
      messageKey: 'member.teamRowNotFound',
    });
  }

  return setTeamMemberStatus(row.id, input, context, request);
};

/**
 * Switch a colleague's login on or off.
 *
 * The OWNER row is refused outright. `findMemberByUserId` only resolves ACTIVE
 * rows, so deactivating the owner would lock the company out of its own account
 * with no way back in from the member side — the one action here that is not
 * reversible by the person taking it.
 *
 * Deactivating keeps the row rather than deleting it: the person may come back,
 * and their name is still attached to whatever they did.
 */
export const setTeamMemberStatus = async (
  id: bigint,
  input: TeamStatusInput,
  context: TeamContext,
  request: TeamRequestContext,
) => {
  const row = await repo.findTeamRow(prisma, context.memberId, id);

  // Scoped to the caller's own company, so another firm's row is "not found"
  // rather than "forbidden" — a 403 would confirm the row exists.
  if (!row) {
    throw new AppError({
      errorType: ERROR_TYPES.NOT_FOUND,
      messageKey: 'member.teamRowNotFound',
    });
  }

  if (row.member_role === MEMBER_ROLE.OWNER) {
    throw new AppError({
      errorType: ERROR_TYPES.VALIDATION_ERROR,
      messageKey: 'member.teamCannotDeactivateOwner',
    });
  }

  const nextStatus = input.active ? MEMBER_USER_STATUS.ACTIVE : MEMBER_USER_STATUS.DEACTIVATED;

  return prisma.$transaction(async (tx) => {
    const updated = await repo.updateTeamRow(tx, id, {
      status: nextStatus,
      deactivated_at: input.active ? null : new Date(),
      updated_by_user_id: context.userId,
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.MEMBER_TEAM_STATUS_CHANGED,
      entityName: 'MemberUsers',
      entityId: id,
      actorType: ACTOR_TYPES.MEMBER,
      actorId: context.userId,
      before: { status: row.status },
      after: { status: nextStatus },
      ip: request.ip,
      userAgent: request.userAgent,
      requestId: request.requestId,
    });

    return { id: updated.id.toString(), status: updated.status };
  });
};
