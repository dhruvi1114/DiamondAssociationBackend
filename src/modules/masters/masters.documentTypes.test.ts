import { beforeEach, describe, expect, it, vi } from 'vitest';

const repo = vi.hoisted(() => ({
  findDocumentTypeById: vi.fn(),
  countDocumentTypeUsage: vi.fn(),
  updateDocumentType: vi.fn(),
}));

vi.mock('@modules/masters/masters.repository', () => repo);
vi.mock('@db/prisma', () => ({
  prisma: { $transaction: (fn: (tx: unknown) => unknown) => fn({}) },
}));
vi.mock('@helpers/audit', () => ({ writeAudit: vi.fn() }));

const { deleteDocumentType } = await import('@modules/masters/masters.service');

const ACTOR = { id: 1n, ip: null, userAgent: null, requestId: null };

describe('deleteDocumentType', () => {
  beforeEach(() => {
    repo.findDocumentTypeById.mockResolvedValue({ id: 7n, code: 'PAN_DOCUMENT', name: 'PAN Card' });
    repo.countDocumentTypeUsage.mockResolvedValue(0);
  });

  it('refuses to retire a type that uploaded files still point at', async () => {
    repo.countDocumentTypeUsage.mockResolvedValue(3);

    await expect(deleteDocumentType(7n, ACTOR)).rejects.toMatchObject({
      messageKey: 'masters.documentTypeInUse',
    });
    expect(repo.updateDocumentType).not.toHaveBeenCalled();
  });

  it('soft-deletes a type nothing references', async () => {
    await deleteDocumentType(7n, ACTOR);

    expect(repo.updateDocumentType).toHaveBeenCalledWith(
      expect.anything(),
      7n,
      expect.objectContaining({ is_active: false, deletedAt: expect.any(Date) }),
    );
  });

  it('still reports a missing type as not found, not in use', async () => {
    repo.findDocumentTypeById.mockResolvedValue(null);

    await expect(deleteDocumentType(7n, ACTOR)).rejects.toMatchObject({
      messageKey: 'masters.documentTypeNotFound',
    });
  });
});
