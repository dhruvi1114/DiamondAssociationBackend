import { beforeEach, describe, expect, it, vi } from 'vitest';

const checklist = vi.hoisted(() => ({
  findTypeForUpload: vi.fn(),
  findTypeById: vi.fn(),
  checklistFor: vi.fn(),
}));
vi.mock('@modules/masters/masters.checklist', () => checklist);
vi.mock('@db/prisma', () => ({ prisma: {} }));

const { validateApplicationFileBuffer } = await import('@modules/document/document.service');

// Real magic bytes — the validator sniffs, it does not trust the declared mime.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
// `sniffMime` refuses anything under 12 bytes, so pad past the header.
const PDF = Buffer.from('255044462d312e340a0a25c4e5f2e5eba7', 'hex');

const TYPE = {
  id: 9n,
  code: 'AADHAAR_CARD',
  name: 'Aadhaar Card',
  description: null,
  is_required: true,
  sides: 'FRONT_AND_BACK' as const,
  max_size_mb: 10,
  allowed_mime: ['application/pdf', 'image/png'],
  display_order: 1,
};

describe('validateApplicationFileBuffer', () => {
  beforeEach(() => checklist.findTypeForUpload.mockResolvedValue(TYPE));

  it('rejects a code with no active type', async () => {
    checklist.findTypeForUpload.mockResolvedValue(null);

    await expect(validateApplicationFileBuffer('NOPE', PNG, 'image/png')).rejects.toMatchObject({
      messageKey: 'masters.documentTypeNotFound',
    });
  });

  it('rejects a file above the type’s own ceiling', async () => {
    checklist.findTypeForUpload.mockResolvedValue({ ...TYPE, max_size_mb: 1 });
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);

    await expect(
      validateApplicationFileBuffer('AADHAAR_CARD', big, 'image/png'),
    ).rejects.toMatchObject({ messageKey: 'document.tooLarge' });
  });

  it('rejects an empty file', async () => {
    await expect(
      validateApplicationFileBuffer('AADHAAR_CARD', Buffer.alloc(0), 'image/png'),
    ).rejects.toMatchObject({ messageKey: 'document.empty' });
  });

  it('rejects a mime the type does not allow', async () => {
    checklist.findTypeForUpload.mockResolvedValue({ ...TYPE, allowed_mime: ['application/pdf'] });

    await expect(
      validateApplicationFileBuffer('AADHAAR_CARD', PNG, 'image/png'),
    ).rejects.toMatchObject({ messageKey: 'document.unsupportedType' });
  });

  it('stores an image against a two-sided type as the face requested', async () => {
    await expect(
      validateApplicationFileBuffer('AADHAAR_CARD', PNG, 'image/png', 'BACK'),
    ).resolves.toMatchObject({ side: 'BACK', type: expect.objectContaining({ id: 9n }) });
  });

  it('stores a PDF against a two-sided type as both faces', async () => {
    await expect(
      validateApplicationFileBuffer('AADHAAR_CARD', PDF, 'application/pdf', 'FRONT'),
    ).resolves.toMatchObject({ side: 'COMBINED' });
  });

  it('ignores a requested face on a single-sided type', async () => {
    checklist.findTypeForUpload.mockResolvedValue({ ...TYPE, sides: 'SINGLE' as const });

    await expect(
      validateApplicationFileBuffer('AADHAAR_CARD', PNG, 'image/png', 'BACK'),
    ).resolves.toMatchObject({ side: 'SINGLE' });
  });
});
