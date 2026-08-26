import type { PrismaClient } from '@prisma/client';

const COMPANY_TYPES = [
  { code: 'PROPRIETARY', name: 'Proprietary', display_order: 1 },
  { code: 'PARTNERSHIP', name: 'Partnership', display_order: 2 },
  { code: 'PRIVATE_LTD', name: 'Private Ltd.', display_order: 3 },
  { code: 'PUBLIC_LTD', name: 'Public Ltd.', display_order: 4 },
] as const;

export const seedCompanyTypes = async (db: PrismaClient): Promise<number> => {
  for (const type of COMPANY_TYPES) {
    await db.companyType.upsert({
      where: { code: type.code },
      update: { name: type.name, display_order: type.display_order, is_active: true, deletedAt: null },
      create: { ...type, is_active: true },
    });
  }

  return COMPANY_TYPES.length;
};
