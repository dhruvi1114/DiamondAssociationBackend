import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `checklistForMember` — the member's KYC checklist (2026-09-11).
 *
 * Pins the held-but-not-listed rows: a member's GST certificate is carried over
 * from the application, but its type is filed under APPLICATION, so it reaches
 * this list without being asked for. It must carry its type's real upload rules
 * — it once carried a 0 MB placeholder, and the screen offered a Replace that
 * refused every file — and it must never count towards what is required.
 */

const checklist = vi.hoisted(() => ({
  findTypeForUpload: vi.fn(),
  findTypeById: vi.fn(),
  checklistFor: vi.fn(),
}));
const memberDocument = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock('@modules/masters/masters.checklist', () => checklist);
vi.mock('@db/prisma', () => ({ prisma: { memberDocument } }));

const { checklistForMember } = await import('@modules/document/document.service');

/** A type the MEMBER checklist asks for. */
const TRADE_REGISTER = {
  id: 20n,
  code: 'TRADE_REGISTER',
  name: 'Trade register',
  description: null,
  is_required: true,
  sides: 'SINGLE' as const,
  max_size_mb: 5,
  allowed_mime: ['application/pdf'],
  display_order: 1,
};

/** A file the member holds whose type is filed under APPLICATION — not listed. */
const HELD_GST = {
  id: 700n,
  document_type_id: 1n,
  side: 'SINGLE',
  version: 1,
  verification_status: 'VERIFIED',
  document_type: {
    id: 1n,
    code: 'GST_CERTIFICATE',
    name: 'GST certificate',
    is_required: true,
    sides: 'SINGLE',
    max_size_mb: 10,
    allowed_mime: ['application/pdf', 'image/jpeg', 'image/png'],
  },
};

describe('checklistForMember', () => {
  beforeEach(() => {
    checklist.checklistFor.mockResolvedValue([TRADE_REGISTER]);
    memberDocument.findMany.mockResolvedValue([HELD_GST]);
  });

  it('keeps a type the member is asked for uploadable, with its real limits', async () => {
    const { items } = await checklistForMember(1n);
    const listed = items.find((item) => item.code === 'TRADE_REGISTER');

    expect(listed).toMatchObject({ uploadable: true, max_size_mb: 5 });
  });

  it('lists a carried-over document with its real rules, so it can be replaced', async () => {
    const { items } = await checklistForMember(1n);
    const held = items.find((item) => item.code === 'GST_CERTIFICATE');

    // Present — a verified file is never invisible — and replaceable against
    // the type's own limits, not a 0 MB placeholder that refused every file.
    expect(held).toMatchObject({
      uploadable: true,
      max_size_mb: 10,
      allowed_mime: ['application/pdf', 'image/jpeg', 'image/png'],
      is_required: false,
    });
    expect(held?.document).toBeTruthy();
  });

  it('never counts a carried-over document towards what is required', async () => {
    const { completeness } = await checklistForMember(1n);

    // One required type is asked for and nothing is uploaded against it; the
    // held GST certificate neither adds to the total nor satisfies it.
    expect(completeness).toMatchObject({ required_total: 1, required_supplied: 0 });
  });
});
