import { describe, expect, it, vi, beforeEach } from 'vitest';

const findEventById = vi.fn();
const updateEvent = vi.fn();
const countPublishAudience = vi.fn();
const writeAudit = vi.fn();

vi.mock('@db/prisma', () => ({
  prisma: { $transaction: async (fn: (tx: unknown) => unknown) => fn({}) },
}));

vi.mock('@modules/event/event.repository', () => ({
  findEventById: (...a: unknown[]) => findEventById(...a),
  updateEvent: (...a: unknown[]) => updateEvent(...a),
  countPublishAudience: (...a: unknown[]) => countPublishAudience(...a),
  createEvent: vi.fn(),
  deleteTiersForEvent: vi.fn(),
  createTiers: vi.fn(),
  findEventBySlug: vi.fn(),
  slugExists: vi.fn(),
  listEventsAdmin: vi.fn(),
}));

vi.mock('@helpers/audit', () => ({ writeAudit: (...a: unknown[]) => writeAudit(...a) }));

const { publishEvent, cancelEvent } = await import('@modules/event/event.service');

const actor = { id: 1n, ip: null, userAgent: null, requestId: null };

const draft = {
  id: 5n,
  title: 'Export Summit 2026',
  status: 0,
  visibility: 1,
  seats_taken: 0,
  price_tiers: [{ id: 1n }],
};

beforeEach(() => {
  vi.clearAllMocks();
  countPublishAudience.mockResolvedValue(1240);
  updateEvent.mockResolvedValue({ id: 5n, status: 1 });
});

describe('publishEvent', () => {
  it('publishes a draft and reports the audience it reached', async () => {
    findEventById.mockResolvedValue(draft);

    const result = await publishEvent(5n, actor);

    expect(updateEvent.mock.calls[0][2]).toMatchObject({ status: 1, updated_by_admin_id: 1n });
    expect(result).toMatchObject({ id: '5', status: 1, audience_size: 1240 });
  });

  it('refuses to publish an event with no price tier', async () => {
    findEventById.mockResolvedValue({ ...draft, price_tiers: [] });

    await expect(publishEvent(5n, actor)).rejects.toMatchObject({
      messageKey: 'event.noPriceTier',
    });

    expect(updateEvent).not.toHaveBeenCalled();
  });

  it('refuses to publish an already-published event', async () => {
    findEventById.mockResolvedValue({ ...draft, status: 1 });

    await expect(publishEvent(5n, actor)).rejects.toMatchObject({
      messageKey: 'event.alreadyPublished',
    });
  });

  it('refuses to publish a cancelled event', async () => {
    findEventById.mockResolvedValue({ ...draft, status: 2 });

    await expect(publishEvent(5n, actor)).rejects.toMatchObject({
      messageKey: 'event.cancelledCannotEdit',
    });
  });

  it('refuses an event that does not exist', async () => {
    findEventById.mockResolvedValue(null);

    await expect(publishEvent(5n, actor)).rejects.toMatchObject({ messageKey: 'event.notFound' });
  });
});

describe('cancelEvent', () => {
  it('cancels a published event that nobody has booked', async () => {
    findEventById.mockResolvedValue({ ...draft, status: 1 });
    updateEvent.mockResolvedValue({ id: 5n, status: 2 });

    const result = await cancelEvent(5n, { reason: 'Venue withdrew' }, actor);

    expect(updateEvent.mock.calls[0][2]).toMatchObject({ status: 2 });
    expect(result).toMatchObject({ id: '5', status: 2 });
  });

  it('refuses while seats are held, until the refund flow exists', async () => {
    findEventById.mockResolvedValue({ ...draft, status: 1, seats_taken: 3 });

    await expect(cancelEvent(5n, { reason: 'x' }, actor)).rejects.toMatchObject({
      messageKey: 'event.hasRegistrations',
    });

    expect(updateEvent).not.toHaveBeenCalled();
  });

  it('refuses to cancel the same event twice', async () => {
    findEventById.mockResolvedValue({ ...draft, status: 2 });

    await expect(cancelEvent(5n, { reason: 'x' }, actor)).rejects.toMatchObject({
      messageKey: 'event.cancelledCannotEdit',
    });
  });
});
