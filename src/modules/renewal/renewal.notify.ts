import { NotificationChannel } from '@prisma/client';
import type { Db } from '@db/prisma';
import { queueNotifications } from '@notifications/outbox';

/**
 * Renewal messages go to the company's primary login, on email and in-app. No address means no
 * message — the renewal itself still happens (same rule as membershipNotify.send).
 * Mirrors the `queueNotifications` argument shape `activation.service.ts` uses for
 * `application.approved` (templateCode, userId, memberId, toAddress, payload) verbatim —
 * `queueNotifications` itself nulls `toAddress` for the IN_APP channel.
 */
export const notifyMember = async (
  db: Db,
  memberId: bigint,
  templateCode: 'membership.renewal_reminder' | 'membership.expired',
  payload: Record<string, string>,
): Promise<number> => {
  const member = await db.member.findFirst({
    where: { id: memberId },
    select: { company_name: true, primary_user: { select: { id: true, email: true } } },
  });
  if (!member?.primary_user?.email) return 0;

  await queueNotifications(db, [NotificationChannel.EMAIL, NotificationChannel.IN_APP], {
    templateCode,
    memberId,
    userId: member.primary_user.id,
    toAddress: member.primary_user.email,
    payload: { name: member.company_name, ...payload },
  });
  return 1;
};
