import { MemberStatus, Prisma, TermStatus } from '@prisma/client';
import { prisma } from '@db/prisma';
import { logger } from '@logger/logger';
import { getNumericSetting, getSetting, SETTING_KEYS, type RenewalBasis } from '@helpers/settings';
import { startTerm } from '@modules/billing/membershipActivation';
import * as memberRepo from '@modules/member/member.repository';
import { addDays, daysBetween, dbToday, isoDay } from '@modules/renewal/renewal.dates';
import { notifyMember } from '@modules/renewal/renewal.notify';
import { raiseRenewal } from '@modules/renewal/renewal.raise';
import * as repo from '@modules/renewal/renewal.repository';
import { headlineFor, reminderStageFor } from '@modules/renewal/renewal.state';

export interface CycleSummary {
  closed: number;
  started: number;
  expired: number;
  raised: number;
  skipped: { member_code: string | null; company_name: string; reason: string }[];
  reminded: number;
}

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/** A term past its last day is over. The member keeps ACTIVE status through grace. */
export const closeEndedTerms = async (today: Date): Promise<number> => {
  const result = await prisma.membershipTerm.updateMany({
    where: { status: TermStatus.ACTIVE, valid_till: { lt: today } },
    data: { status: TermStatus.EXPIRED },
  });
  return result.count;
};

/**
 * Renewals paid ahead start on their first day.
 *
 * Delegates the one-ACTIVE-term switch to `startTerm` (`@modules/billing/membershipActivation`,
 * Task 6) rather than repeating its updateMany/update/update inline — that rule lives in one
 * place, whether a term is started by a payment coming in or by this sweep finding its day.
 */
export const startPaidTerms = async (today: Date): Promise<number> => {
  const due = await prisma.membershipTerm.findMany({
    where: { status: TermStatus.PAID_UPCOMING, valid_from: { lte: today } },
    select: { id: true, member_id: true },
    orderBy: { valid_from: 'asc' },
  });

  let started = 0;
  for (const term of due) {
    try {
      await prisma.$transaction(async (tx) => {
        await startTerm(tx, term.member_id, term.id);
      });
      started += 1;
    } catch (error) {
      logger.error('renewal.startPaidTerm.failed', {
        termId: term.id.toString(),
        detail: String(error),
      });
    }
  }
  return started;
};

/** Grace is over: the member leaves the directory and member pricing, keeps their login. */
export const expireLapsedMembers = async (today: Date, graceDays: number): Promise<number> => {
  const cutoff = addDays(today, -graceDays);
  const lapsed = await prisma.member.findMany({
    where: {
      status: MemberStatus.ACTIVE,
      deletedAt: null,
      current_term: { status: TermStatus.EXPIRED, valid_till: { lt: cutoff } },
    },
    select: { id: true, current_term: { select: { valid_till: true } } },
  });

  let expired = 0;
  for (const member of lapsed) {
    const endedOn = isoDay(member.current_term!.valid_till);
    try {
      await prisma.$transaction(async (tx) => {
        await memberRepo.updateMember(tx, member.id, { status: MemberStatus.EXPIRED });
        await memberRepo.recordStatusChange(tx, {
          member_id: member.id,
          from_status: MemberStatus.ACTIVE,
          to_status: MemberStatus.EXPIRED,
          reason: `Membership ended ${endedOn}; the ${graceDays}-day grace period passed without renewal`,
          changed_by_admin_id: null,
        });
        await notifyMember(tx, member.id, 'membership.expired', { expired_on: endedOn });
      });
      expired += 1;
    } catch (error) {
      logger.error('renewal.expire.failed', {
        memberId: member.id.toString(),
        detail: String(error),
      });
    }
  }
  return expired;
};

export const raiseDueRenewals = async (
  today: Date,
  cfg: { noticeDays: number; basis: RenewalBasis; dueDays: number },
): Promise<Pick<CycleSummary, 'raised' | 'skipped'>> => {
  const candidates = await repo.dueCandidates(prisma, addDays(today, cfg.noticeDays));
  const summary: Pick<CycleSummary, 'raised' | 'skipped'> = { raised: 0, skipped: [] };

  for (const c of candidates) {
    const who = { member_code: c.member_code, company_name: c.company_name };
    try {
      const result = await prisma.$transaction((tx) =>
        raiseRenewal(
          tx,
          {
            memberId: c.member_id,
            categoryId: c.category_id,
            tierId: c.tier_id,
            feePlanId: c.fee_plan_id,
            previousValidTill: c.valid_till,
          },
          { today, basis: cfg.basis, dueDays: cfg.dueDays },
        ),
      );
      if (result.outcome === 'RAISED') summary.raised += 1;
      else summary.skipped.push({ ...who, reason: result.reason });
    } catch (error) {
      if (isUniqueViolation(error)) {
        summary.skipped.push({ ...who, reason: 'ALREADY_RAISED' });
      } else {
        summary.skipped.push({ ...who, reason: 'FAILED' });
        logger.error('renewal.raise.failed', {
          memberId: c.member_id.toString(),
          detail: String(error),
        });
      }
    }
  }
  return summary;
};

export const sendRenewalReminders = async (today: Date): Promise<number> => {
  const rows = await repo.reminderCandidates(prisma, today);
  let sent = 0;

  for (const row of rows) {
    const expiresOn = addDays(row.valid_from, -1);
    const code = reminderStageFor(daysBetween(today, expiresOn));
    if (!code) continue;

    try {
      await prisma.$transaction(async (tx) => {
        const inserted = await repo.claimReminder(tx, row.term_id, code, today);
        if (inserted === 0) return;
        sent += await notifyMember(tx, row.member_id, 'membership.renewal_reminder', {
          headline: headlineFor(code, isoDay(expiresOn)),
          plan_name: row.plan_name ?? 'Membership',
          amount: `${row.currency} ${row.total_amount.toFixed(2)}`,
          invoice_number: row.invoice_number,
          expires_on: isoDay(expiresOn),
          due_on: isoDay(row.due_date),
        });
      });
    } catch (error) {
      logger.error('renewal.remind.failed', {
        termId: row.term_id.toString(),
        detail: String(error),
      });
    }
  }
  return sent;
};

/**
 * One pass of the renewal machinery. Order matters: ended terms close before paid ones start
 * (one ACTIVE term per member), and members expire before anything is billed. Every step is
 * safe to run twice — the hourly schedule and the admin's "Generate Invoices" both call this.
 */
export const runRenewalCycle = async (now: Date = new Date()): Promise<CycleSummary> => {
  const today = dbToday(now);
  const basis = ((await getSetting(SETTING_KEYS.RENEWAL_BASIS)) ?? 'term') as RenewalBasis;
  const noticeDays = await getNumericSetting(SETTING_KEYS.RENEWAL_NOTICE_DAYS, 15);
  const graceDays = await getNumericSetting(SETTING_KEYS.MEMBERSHIP_GRACE_DAYS, 30);
  const dueDays = await getNumericSetting(SETTING_KEYS.INVOICE_DUE_DAYS, 15);

  const closed = await closeEndedTerms(today);
  const started = await startPaidTerms(today);
  const expired = await expireLapsedMembers(today, graceDays);
  const { raised, skipped } = await raiseDueRenewals(today, { noticeDays, basis, dueDays });
  const reminded = await sendRenewalReminders(today);

  return { closed, started, expired, raised, skipped, reminded };
};
