import { Prisma } from '@prisma/client';

import { prisma } from '@db/prisma';

type Db = Prisma.TransactionClient | typeof prisma;

const handler = { select: { id: true, full_name: true } } as const;

export const enquiryInclude = { handled_by: handler } satisfies Prisma.ContactEnquiryInclude;

export type EnquiryRow = Prisma.ContactEnquiryGetPayload<{ include: typeof enquiryInclude }>;

export const createEnquiry = (db: Db, data: Prisma.ContactEnquiryUncheckedCreateInput) =>
  db.contactEnquiry.create({ data });

export const listEnquiries = (
  db: Db,
  where: Prisma.ContactEnquiryWhereInput,
  skip: number,
  take: number,
): Promise<EnquiryRow[]> =>
  db.contactEnquiry.findMany({
    where,
    include: enquiryInclude,
    // Newest first. An enquiry loses value with age, so the top of this list is
    // always the one most worth answering.
    orderBy: { id: 'desc' },
    skip,
    take,
  });

export const countEnquiries = (db: Db, where: Prisma.ContactEnquiryWhereInput): Promise<number> =>
  db.contactEnquiry.count({ where });

export const findEnquiry = (db: Db, id: bigint): Promise<EnquiryRow | null> =>
  db.contactEnquiry.findFirst({ where: { id, deletedAt: null }, include: enquiryInclude });

export const updateEnquiry = (db: Db, id: bigint, data: Prisma.ContactEnquiryUpdateInput) =>
  db.contactEnquiry.update({ where: { id }, data });
