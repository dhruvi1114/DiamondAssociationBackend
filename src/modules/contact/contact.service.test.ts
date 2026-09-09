import { describe, expect, it, vi, beforeEach } from 'vitest';

const createEnquiry = vi.fn();
const findEnquiry = vi.fn();
const updateEnquiry = vi.fn();
const listEnquiries = vi.fn();
const countEnquiries = vi.fn();
const queueNotification = vi.fn();
const writeAudit = vi.fn();

vi.mock('@db/prisma', () => ({
  prisma: { $transaction: async (fn: (tx: unknown) => unknown) => fn({}) },
}));

vi.mock('@modules/contact/contact.repository', () => ({
  createEnquiry: (...a: unknown[]) => createEnquiry(...a),
  findEnquiry: (...a: unknown[]) => findEnquiry(...a),
  updateEnquiry: (...a: unknown[]) => updateEnquiry(...a),
  listEnquiries: (...a: unknown[]) => listEnquiries(...a),
  countEnquiries: (...a: unknown[]) => countEnquiries(...a),
}));

vi.mock('@notifications/outbox', () => ({
  queueNotification: (...a: unknown[]) => queueNotification(...a),
}));

vi.mock('@helpers/audit', () => ({ writeAudit: (...a: unknown[]) => writeAudit(...a) }));

const service = await import('@modules/contact/contact.service');
const { ENQUIRY_STATUS } = await import('@modules/contact/contact.types');

const actor = { adminId: 9n, ip: null, userAgent: null, requestId: null };
const office = { ip: '203.0.113.7', supportEmail: 'office@ilgda.org' };

const enquiry = {
  name: 'Rajesh Patel',
  email: 'rajesh@surat-polish.com',
  phone: '9825012345',
  subject: 'Membership fee',
  message: 'What is the annual fee for a polishing unit?',
};

beforeEach(() => {
  vi.clearAllMocks();
  createEnquiry.mockResolvedValue({ id: 12n });
});

describe('submitEnquiry', () => {
  it('stores the enquiry before anyone is emailed', async () => {
    await service.submitEnquiry(enquiry, office);

    // The order is the whole design. An enquiry that only ever existed as an
    // email is lost the moment SMTP fails, and nobody learns it was sent.
    expect(createEnquiry).toHaveBeenCalledOnce();
    expect(createEnquiry.mock.invocationCallOrder[0]).toBeLessThan(
      queueNotification.mock.invocationCallOrder[0] as number,
    );
  });

  it('records the sender and the address it came from', async () => {
    await service.submitEnquiry(enquiry, office);

    expect(createEnquiry.mock.calls[0][1]).toMatchObject({
      name: 'Rajesh Patel',
      email: 'rajesh@surat-polish.com',
      subject: 'Membership fee',
      status: ENQUIRY_STATUS.NEW,
      ip: '203.0.113.7',
    });
  });

  it('sets Reply-To to the sender, so Reply does not reach the no-reply account', async () => {
    await service.submitEnquiry(enquiry, office);

    expect(queueNotification.mock.calls[0][1]).toMatchObject({
      templateCode: 'contact.enquiry_received',
      toAddress: 'office@ilgda.org',
      replyTo: 'rajesh@surat-polish.com',
    });
  });

  it('still records the enquiry when no support address is configured', async () => {
    await service.submitEnquiry(enquiry, { ip: null, supportEmail: null });

    // Losing the notification is recoverable — the queue still shows it. Losing
    // the message because nobody set a setting is not.
    expect(createEnquiry).toHaveBeenCalledOnce();
    expect(queueNotification).not.toHaveBeenCalled();
  });

  it('accepts a honeypot submission and stores nothing', async () => {
    const result = await service.submitEnquiry(
      { ...enquiry, website: 'http://spam.example' },
      office,
    );

    // Success, not an error: a bot that is rejected retries without the field
    // and gets through; one that is thanked has no reason to try again.
    expect(result.accepted).toBe(true);
    expect(createEnquiry).not.toHaveBeenCalled();
    expect(queueNotification).not.toHaveBeenCalled();
  });

  it('treats an empty honeypot as a real person', async () => {
    await service.submitEnquiry({ ...enquiry, website: '   ' }, office);

    expect(createEnquiry).toHaveBeenCalledOnce();
  });
});

describe('setEnquiryStatus', () => {
  beforeEach(() => {
    findEnquiry.mockResolvedValue({ id: 12n, status: ENQUIRY_STATUS.NEW });
    updateEnquiry.mockImplementation((_db, id: bigint, data: { status: number }) =>
      Promise.resolve({ id, status: data.status }),
    );
  });

  it('stamps who handled it and when', async () => {
    const row = await service.setEnquiryStatus(12n, true, actor);

    expect(updateEnquiry.mock.calls[0][2]).toMatchObject({
      status: ENQUIRY_STATUS.HANDLED,
      handled_by: { connect: { id: 9n } },
    });
    expect(updateEnquiry.mock.calls[0][2].handled_at).toBeInstanceOf(Date);
    expect(row.status).toBe(ENQUIRY_STATUS.HANDLED);
  });

  it('can be undone, because "handled" is one person’s judgement', async () => {
    findEnquiry.mockResolvedValue({ id: 12n, status: ENQUIRY_STATUS.HANDLED });

    await service.setEnquiryStatus(12n, false, actor);

    expect(updateEnquiry.mock.calls[0][2]).toMatchObject({
      status: ENQUIRY_STATUS.NEW,
      handled_at: null,
      handled_by: { disconnect: true },
    });
  });

  it('is not found rather than a crash when the enquiry is gone', async () => {
    findEnquiry.mockResolvedValue(null);

    await expect(service.setEnquiryStatus(12n, true, actor)).rejects.toMatchObject({
      messageKey: 'communication.enquiryNotFound',
    });
  });
});

describe('listEnquiries', () => {
  beforeEach(() => {
    listEnquiries.mockResolvedValue([]);
    countEnquiries.mockResolvedValue(0);
  });

  it('never returns soft-deleted rows, filtered or not', async () => {
    await service.listEnquiries({ page: 1, limit: 20 });

    expect(listEnquiries.mock.calls[0][1]).toEqual({ AND: [{ deletedAt: null }] });
  });

  it('searches the sender, the address and the subject', async () => {
    await service.listEnquiries({ page: 1, limit: 20, search: 'rajesh' });

    const where = listEnquiries.mock.calls[0][1] as { AND: [unknown, { OR: unknown[] }] };

    expect(where.AND[1].OR).toHaveLength(3);
  });
});
