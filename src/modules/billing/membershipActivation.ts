import { MemberStatus, TermStatus } from '@prisma/client';

import * as repo from '@modules/member/member.repository';
import type { Db } from '@db/prisma';

/**
 * Turning a paid membership invoice into an active membership.
 *
 * Its own module because **two** paths now settle a membership invoice and both
 * have to do this identically: an admin recording an offline payment
 * (`recordInvoicePayment`), and an admin verifying a payment claim the member
 * filed (`verifyPayment`). When the claim flow was added, the second path marked
 * the invoice paid and stopped — the member's terms stayed PENDING_PAYMENT and
 * the member stayed PENDING, which is a company that has paid, been approved,
 * and still cannot use the directory.
 *
 * Takes the transaction it runs in. Marking an invoice paid and switching the
 * membership on are one fact about the association, and a crash between them
 * leaves a paid invoice against a pending member — exactly the inconsistency
 * this guards against.
 */
export const activateMembershipForInvoice = async (
  tx: Db,
  params: {
    invoiceId: bigint;
    memberId: bigint;
    /** Printed into the status-change reason, so an audit reads as a sentence. */
    invoiceNumber: string;
    /** The staff account credited with the change; null when nobody was. */
    changedByAdminId: bigint | null;
  },
) => {
  // Every term this invoice was raised for goes live together — a member does
  // not hold a mix of active and still-pending terms off one payment.
  await tx.membershipTerm.updateMany({
    where: { invoice_id: params.invoiceId, status: TermStatus.PENDING_PAYMENT },
    data: { status: TermStatus.ACTIVE },
  });

  const member = await repo.findMemberById(tx, params.memberId);

  /*
    Only the first payment moves the member. A renewal invoice is paid by a
    company that is already ACTIVE, and re-running the transition would write a
    status-change row saying they joined again.
  */
  if (!member || member.status !== MemberStatus.PENDING) return member;

  const updated = await repo.updateMember(tx, params.memberId, {
    status: MemberStatus.ACTIVE,
    ...(member.joined_on ? {} : { joined_on: new Date() }),
  });

  await repo.recordStatusChange(tx, {
    member_id: params.memberId,
    from_status: member.status,
    to_status: MemberStatus.ACTIVE,
    reason: `Invoice ${params.invoiceNumber} paid`,
    changed_by_admin_id: params.changedByAdminId,
  });

  return updated;
};
