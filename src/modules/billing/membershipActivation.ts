import { MemberStatus, TermStatus, TermType } from '@prisma/client';
import type { BillingCycle } from '@prisma/client';

import { getSetting, SETTING_KEYS } from '@helpers/settings';
import type { RenewalBasis } from '@helpers/settings';
import { CYCLE_MONTHS } from '@modules/masters/masters.feePlans.service';
import * as repo from '@modules/member/member.repository';
import { addDays, daysBetween, dbToday, planRenewalTerm } from '@modules/renewal/renewal.dates';
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
 *
 * M6: a renewal can be paid before its term starts. The database allows one ACTIVE term per
 * member and the current one is still running, so such a term waits as PAID_UPCOMING and the
 * renewal job starts it on its first day. A renewal paid on or after its first day starts now,
 * closing the ended term first — and brings back a member the sweep had already expired.
 *
 * A member's first term starts the day their first invoice is paid, not the day the application
 * was approved (decided 2026-09-11, industry standard): a company is not yet a member while its
 * invoice sits unpaid, so a term dated from approval quietly hands out days nobody has paid for
 * once payment lags behind approval. `activateMembershipForInvoice` re-dates such a term just
 * before starting it — see `firstTermWindow` below for how its billed length survives the move.
 */

/**
 * Make `termId` the member's running term: the member's other ACTIVE term (the one that ended)
 * steps aside first — one ACTIVE term per member (MembershipTerms_one_active_per_member) — then
 * this term goes ACTIVE and becomes the member's current term. Runs in the caller's transaction.
 */
export const startTerm = async (tx: Db, memberId: bigint, termId: bigint): Promise<void> => {
  await tx.membershipTerm.updateMany({
    where: { member_id: memberId, status: TermStatus.ACTIVE, id: { not: termId } },
    data: { status: TermStatus.EXPIRED },
  });
  await tx.membershipTerm.update({ where: { id: termId }, data: { status: TermStatus.ACTIVE } });
  await tx.member.update({ where: { id: memberId }, data: { current_term_id: termId } });
};

/**
 * Where a first term that started before today should really start: today, for the length it was
 * billed.
 *
 * Basis `term` with a priced plan re-plans the term from today at the plan's own cycle length —
 * the same arithmetic a renewal uses. Basis `financial_year` just moves `valid_from` to today and
 * leaves `valid_till` (the 31 March it was priced against) alone, but only while the payment day
 * is strictly before that date — kept as `<`, not `<=`, because paying on the term's own last day
 * would otherwise set `valid_from === valid_till`, which the database's
 * `MembershipTerms_span_ordered` CHECK (`valid_till > valid_from`) refuses. Everything else — no
 * fee plan on the term, or a financial-year term paid on or after its own end — keeps the number
 * of days the member was billed for by shifting both dates forward by however many days late the
 * payment is, which always leaves a positive span.
 */
const firstTermWindow = (
  term: {
    valid_from: Date;
    valid_till: Date;
    fee_plan_id: bigint | null;
    fee_plan: { billing_cycle: BillingCycle } | null;
  },
  today: Date,
  basis: RenewalBasis,
): { valid_from: Date; valid_till: Date } => {
  if (basis === 'term' && term.fee_plan_id && term.fee_plan) {
    const window = planRenewalTerm({
      from: today,
      durationMonths: CYCLE_MONTHS[term.fee_plan.billing_cycle],
      basis: 'term',
    });

    return { valid_from: window.validFrom, valid_till: window.validTill };
  }

  if (basis === 'financial_year' && today < term.valid_till) {
    return { valid_from: today, valid_till: term.valid_till };
  }

  const shift = daysBetween(term.valid_from, today);

  return { valid_from: today, valid_till: addDays(term.valid_till, shift) };
};

export const activateMembershipForInvoice = async (
  tx: Db,
  params: {
    invoiceId: bigint;
    memberId: bigint;
    /** Printed into the status-change reason, so an audit reads as a sentence. */
    invoiceNumber: string;
    /** The staff account credited with the change; null when nobody was. */
    changedByAdminId: bigint | null;
    /** Injected by tests; defaults to the server's local calendar day. */
    today?: Date;
  },
) => {
  const today = params.today ?? dbToday();

  const pending = await tx.membershipTerm.findMany({
    where: { invoice_id: params.invoiceId, status: TermStatus.PENDING_PAYMENT },
    select: {
      id: true,
      valid_from: true,
      valid_till: true,
      term_type: true,
      fee_plan_id: true,
      fee_plan: { select: { billing_cycle: true } },
    },
    orderBy: { valid_from: 'asc' },
  });

  const later = pending.filter((t) => t.valid_from > today);
  const now = pending.filter((t) => t.valid_from <= today);

  if (later.length > 0) {
    await tx.membershipTerm.updateMany({
      where: { id: { in: later.map((t) => t.id) } },
      data: { status: TermStatus.PAID_UPCOMING },
    });
  }

  let activated: bigint | null = null;
  for (const term of now) {
    if (term.term_type === TermType.NEW && term.valid_from < today) {
      const basis = ((await getSetting(SETTING_KEYS.RENEWAL_BASIS)) ?? 'term') as RenewalBasis;
      const redated = firstTermWindow(term, today, basis);

      await tx.membershipTerm.update({
        where: { id: term.id },
        data: { valid_from: redated.valid_from, valid_till: redated.valid_till },
      });
    }

    await startTerm(tx, params.memberId, term.id);
    activated = term.id;
  }

  const member = await repo.findMemberById(tx, params.memberId);
  if (!member) return member;

  /*
    Only the first payment moves the member from PENDING. A renewal invoice is paid by a
    company that is already ACTIVE, and re-running the transition would write a
    status-change row saying they joined again.
  */
  if (member.status === MemberStatus.PENDING) {
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
  }

  // Only a term that started now brings an expired member back; paying ahead does not.
  if (member.status === MemberStatus.EXPIRED && activated !== null) {
    const updated = await repo.updateMember(tx, params.memberId, { status: MemberStatus.ACTIVE });

    await repo.recordStatusChange(tx, {
      member_id: params.memberId,
      from_status: member.status,
      to_status: MemberStatus.ACTIVE,
      reason: `Renewal invoice ${params.invoiceNumber} paid`,
      changed_by_admin_id: params.changedByAdminId,
    });

    return updated;
  }

  return member;
};
