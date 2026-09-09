import { NotificationChannel, Prisma } from '@prisma/client';

import { ACTOR_TYPES, AUDIT_ACTIONS } from '@constant/audit.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { prisma } from '@db/prisma';
import { writeAudit } from '@helpers/audit';
import { queueNotification } from '@notifications/outbox';
import { AppError } from '@utils/appError';
import * as repo from '@modules/contact/contact.repository';
import { ENQUIRY_STATUS } from '@modules/contact/contact.types';
import type { EnquiryRow } from '@modules/contact/contact.repository';
import type { ListEnquiriesQuery, SubmitEnquiryInput } from '@modules/contact/contact.types';

/**
 * The public contact form, and the queue it feeds.
 *
 * One rule shapes the whole module: **the enquiry is written to the database
 * before anybody is emailed.** An enquiry that only ever existed as an email is
 * gone the moment SMTP fails, and nobody learns it was ever sent — which is the
 * one failure a contact form must not have. Stored first, it survives any mail
 * problem, and the outbox retries the notification on its own.
 *
 * The association replies from its own inbox, not from here. `Reply-To` on the
 * notification carries the enquirer's address, so pressing Reply reaches them
 * rather than the platform's no-reply account. That keeps this a tracked to-do
 * list rather than a helpdesk nobody has time to maintain.
 */

export interface AdminActor {
  adminId: bigint;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

/** What the queue shows for one enquiry. */
export const present = (row: EnquiryRow) => ({
  id: row.id.toString(),
  name: row.name,
  email: row.email,
  phone: row.phone,
  subject: row.subject,
  message: row.message,
  status: row.status,
  handled_by: row.handled_by?.full_name ?? null,
  handled_at: row.handled_at,
  createdAt: row.createdAt,
});

/**
 * Take an enquiry from a visitor.
 *
 * The honeypot is answered with success, not an error. A bot that receives a
 * rejection retries with the field removed and gets through on the second
 * attempt; one that receives a cheerful 200 has no reason to try again. The
 * cost of being wrong is one lost message from somebody with a very unusual
 * browser extension, against every automated submission that would otherwise
 * reach the office inbox.
 */
export const submitEnquiry = async (
  input: SubmitEnquiryInput,
  context: { ip: string | null; supportEmail: string | null },
) => {
  if (input.website && input.website.trim() !== '') {
    return { accepted: true as const };
  }

  const enquiry = await prisma.$transaction(async (tx) => {
    const created = await repo.createEnquiry(tx, {
      name: input.name,
      email: input.email,
      phone: input.phone ?? null,
      subject: input.subject,
      message: input.message,
      status: ENQUIRY_STATUS.NEW,
      ip: context.ip,
    });

    /*
      Queued after the row exists, inside the same transaction. If the queue
      insert fails the enquiry rolls back too — better a visitor who is told to
      try again than a message sitting in a table nobody is told about.
    */
    if (context.supportEmail) {
      await queueNotification(tx, {
        templateCode: 'contact.enquiry_received',
        channel: NotificationChannel.EMAIL,
        toAddress: context.supportEmail,
        // The sender's own address, so Reply in the office inbox reaches them
        // instead of the platform's no-reply account.
        replyTo: input.email,
        payload: {
          name: input.name,
          email: input.email,
          phone: input.phone ?? 'Not given',
          subject: input.subject,
          message: input.message,
        },
      });
    }

    return created;
  });

  return { accepted: true as const, id: enquiry.id.toString() };
};

export const listEnquiries = async (query: ListEnquiriesQuery) => {
  const conditions: Prisma.ContactEnquiryWhereInput[] = [{ deletedAt: null }];

  if (query.status !== undefined) conditions.push({ status: query.status });

  if (query.search) {
    const term = query.search;

    conditions.push({
      OR: [
        { name: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
        { subject: { contains: term, mode: 'insensitive' } },
      ],
    });
  }

  const where: Prisma.ContactEnquiryWhereInput = { AND: conditions };

  const [rows, total] = await Promise.all([
    repo.listEnquiries(prisma, where, (query.page - 1) * query.limit, query.limit),
    repo.countEnquiries(prisma, where),
  ]);

  return { rows: rows.map(present), total, page: query.page, limit: query.limit };
};

/**
 * Mark an enquiry dealt with, or put it back.
 *
 * Reversible on purpose. "Handled" is one person's judgement about a message
 * they read in a hurry, and a one-way flag makes the mistake permanent.
 */
export const setEnquiryStatus = async (id: bigint, handled: boolean, actor: AdminActor) => {
  const enquiry = await repo.findEnquiry(prisma, id);

  if (!enquiry) {
    throw new AppError({
      errorType: ERROR_TYPES.NOT_FOUND,
      messageKey: 'communication.enquiryNotFound',
    });
  }

  const status = handled ? ENQUIRY_STATUS.HANDLED : ENQUIRY_STATUS.NEW;

  return prisma.$transaction(async (tx) => {
    const updated = await repo.updateEnquiry(tx, id, {
      status,
      handled_at: handled ? new Date() : null,
      handled_by: handled ? { connect: { id: actor.adminId } } : { disconnect: true },
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.CONTACT_ENQUIRY_HANDLED,
      entityName: 'ContactEnquiries',
      entityId: id,
      actorType: ACTOR_TYPES.ADMIN,
      actorId: actor.adminId,
      before: { status: enquiry.status },
      after: { status },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return { id: updated.id.toString(), status: updated.status };
  });
};
