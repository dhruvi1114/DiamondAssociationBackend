import { beforeEach, describe, expect, it, vi } from 'vitest';

const findMany = vi.fn();
const findFirst = vi.fn();

vi.mock('@db/prisma', () => ({
  prisma: {
    documentType: {
      findMany: (...a: unknown[]) => findMany(...a),
      findFirst: (...a: unknown[]) => findFirst(...a),
    },
  },
}));

const { checklistFor, findTypeById, findTypeForUpload } =
  await import('@modules/masters/masters.checklist');

const ROW = {
  id: 4n,
  code: 'AADHAAR_CARD',
  name: 'Aadhaar Card',
  description: null,
  is_required: true,
  sides: 'FRONT_AND_BACK',
  max_size_mb: 10,
  allowed_mime: ['image/png'],
  display_order: 2,
};

describe('checklistFor', () => {
  beforeEach(() => findMany.mockResolvedValue([ROW]));

  it('asks for APPLICATION and BOTH rows on the registration surface', async () => {
    await checklistFor('APPLICATION');

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deletedAt: null,
          is_active: true,
          applies_to: { in: ['APPLICATION', 'BOTH'] },
        }),
      }),
    );
  });

  it('asks for MEMBER and BOTH rows on the profile surface', async () => {
    await checklistFor('MEMBER');

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ applies_to: { in: ['MEMBER', 'BOTH'] } }),
      }),
    );
  });

  it('returns the row shape the API and the forms render', async () => {
    await expect(checklistFor('APPLICATION')).resolves.toEqual([
      expect.objectContaining({ code: 'AADHAAR_CARD', sides: 'FRONT_AND_BACK', is_required: true }),
    ]);
  });
});

describe('findTypeForUpload', () => {
  it('refuses a retired type for a new upload', async () => {
    findFirst.mockResolvedValue(null);

    await expect(findTypeForUpload('OLD_CODE')).resolves.toBeNull();
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { code: 'OLD_CODE', deletedAt: null, is_active: true } }),
    );
  });
});

describe('findTypeById', () => {
  it('resolves a retired type, because a file already points at it', async () => {
    findFirst.mockResolvedValue(ROW);

    await findTypeById(4n);

    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 4n } }));
  });
});
