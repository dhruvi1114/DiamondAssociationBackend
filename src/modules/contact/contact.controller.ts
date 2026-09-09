import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { RES_STATUS } from '@constant/message.constant';
import { prisma } from '@db/prisma';
import * as service from '@modules/contact/contact.service';
import { AppError } from '@utils/appError';
import { handleApiResponse } from '@utils/handleResponse';

/** HTTP layer for the public contact form and the enquiry queue behind it. */

const handler =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next: NextFunction) => {
    void fn(req, res).catch(next);
  };

const actor = (req: Request): service.AdminActor => {
  if (req.actor?.id === undefined) {
    throw new AppError({ errorType: ERROR_TYPES.UNAUTHORIZED, messageKey: 'auth.unauthorized' });
  }

  return {
    adminId: req.actor.id,
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    requestId: req.requestId ?? null,
  };
};

const serialise = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (_key, raw: unknown) => (typeof raw === 'bigint' ? raw.toString() : raw)),
  );

/**
 * Where enquiries are delivered.
 *
 * Read at send time rather than baked in, so the office can redirect its own
 * enquiries in Settings without a deploy. Blank is not an error: the enquiry is
 * still recorded and still shows in the queue — it simply arrives by nobody's
 * inbox until an address is configured.
 */
const supportEmail = async (): Promise<string | null> => {
  const row = await prisma.systemSetting.findFirst({
    where: { key: 'organisation.support_email' },
    select: { value: true },
  });

  const value = row?.value?.trim();

  return value ? value : null;
};

/** `POST /public/contact` — a visitor writes to the association. No login. */
export const submitEnquiry = handler(async (req, res) => {
  await service.submitEnquiry(req.body as never, {
    ip: req.ip ?? null,
    supportEmail: await supportEmail(),
  });

  handleApiResponse(res, {
    responseType: RES_STATUS.CREATE,
    messageKey: 'communication.enquiryReceived',
    /*
      No id back. The sender has no use for one, and returning it would let a
      caller confirm which submissions were stored — including the ones the
      honeypot silently discarded.
    */
    data: { accepted: true },
  });
});

/** `GET /admin/contact-enquiries` — the queue. */
export const listEnquiries = handler(async (req, res) => {
  const { rows, total, page, limit } = await service.listEnquiries(req.query as never);

  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise(rows),
    pagination: { page, limit, total },
  });
});

/** `PATCH /admin/contact-enquiries/:id/status` — handled, or back on the queue. */
export const setEnquiryStatus = handler(async (req, res) => {
  const { handled } = req.body as { handled: boolean };

  const row = await service.setEnquiryStatus(BigInt(req.params.id as string), handled, actor(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: handled ? 'communication.enquiryHandled' : 'communication.enquiryReopened',
    data: serialise(row),
  });
});
