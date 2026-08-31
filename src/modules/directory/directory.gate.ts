import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { prisma } from '@db/prisma';
import { findMemberByUserId } from '@modules/member/member.repository';
import { AppError } from '@utils/appError';

import { DIRECTORY_DENY, type DirectoryDenyReason } from '@modules/directory/directory.constants';

/**
 * Who may open the member directory.
 *
 * The gate is the caller's own company status, not the presence of a token.
 * `DRAFT` and `PENDING` are the same refusal — both mean "has not paid" — and
 * `TERMINATED` is reported as `EXPIRED` because the customer app has nothing
 * different to offer a terminated company, and naming the distinction to the
 * browser restates a decision the association may not want restated.
 *
 * `findMemberByUserId` resolves through `MemberUsers`, so an invited colleague
 * of a paying firm passes on the firm's status — which is correct. The company
 * pays; the colleague is part of what it paid for.
 */
const REASON_FOR_STATUS: Record<string, DirectoryDenyReason> = {
  DRAFT: DIRECTORY_DENY.PAYMENT_PENDING,
  PENDING: DIRECTORY_DENY.PAYMENT_PENDING,
  SUSPENDED: DIRECTORY_DENY.SUSPENDED,
  EXPIRED: DIRECTORY_DENY.EXPIRED,
  TERMINATED: DIRECTORY_DENY.EXPIRED,
};

export const directoryDenied = (reason: DirectoryDenyReason): AppError =>
  new AppError({
    errorType: ERROR_TYPES.FORBIDDEN,
    messageKey: 'directory.forbidden',
    details: { reason },
  });

export const assertDirectoryAccess = async (userId: bigint): Promise<{ memberId: bigint }> => {
  /*
    Read per request, never cached and never taken from a token claim. A member
    suspended five minutes ago must fail their next request rather than keep the
    directory until their access token happens to expire.
  */
  const member = await findMemberByUserId(prisma, userId);

  if (!member) throw directoryDenied(DIRECTORY_DENY.NO_MEMBERSHIP);

  if (member.status !== 'ACTIVE') {
    throw directoryDenied(REASON_FOR_STATUS[member.status] ?? DIRECTORY_DENY.NO_MEMBERSHIP);
  }

  return { memberId: member.id };
};
