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

const cancelEventWithRefunds = vi.fn();

vi.mock('@modules/event/registration.service', () => ({
  cancelEventWithRefunds: (...a: unknown[]) => cancelEventWithRefunds(...a),
}));

const { publishEvent, cancelEvent, deleteEvent } = await import('@modules/event/event.service');

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
  cancelEventWithRefunds.mockResolvedValue({ cancelled: 0, refunded: 0, failed: 0 });
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

  /*
    The rule changed deliberately: an event with bookings is no longer refused,
    it is cancelled and everyone is refunded. Refusing was only ever a
    placeholder for the refund flow not existing yet.
  */
  it('cancels every booking and refunds them before marking the event off', async () => {
    findEventById.mockResolvedValue({ ...draft, status: 1, seats_taken: 3 });
    updateEvent.mockResolvedValue({ id: 5n, status: 2 });
    cancelEventWithRefunds.mockResolvedValue({ cancelled: 2, refunded: 1, failed: 0 });

    const result = await cancelEvent(5n, { reason: 'Venue withdrew' }, actor);

    expect(cancelEventWithRefunds).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: 2, bookings_cancelled: 2, refunds_raised: 1 });
  });

  /*
    Half-cancelled is the one state nobody can act on — some attendees told, some
    not, and no way to tell which from the screen. So the event stays live and
    the whole thing is retried.
  */
  it('leaves the event live if any booking could not be refunded', async () => {
    findEventById.mockResolvedValue({ ...draft, status: 1, seats_taken: 3 });
    cancelEventWithRefunds.mockResolvedValue({ cancelled: 1, refunded: 0, failed: 1 });

    await expect(cancelEvent(5n, { reason: 'x' }, actor)).rejects.toMatchObject({
      messageKey: 'event.cancelPartiallyFailed',
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

describe('deleteEvent', () => {
  it('removes an event nobody has booked', async () => {
    findEventById.mockResolvedValue({ ...draft, status: 1 });
    updateEvent.mockResolvedValue({ id: 5n });

    const result = await deleteEvent(5n, actor);

    expect(updateEvent.mock.calls[0][2].deletedAt).toBeInstanceOf(Date);
    expect(result).toMatchObject({ id: '5' });
  });

  it('refuses while seats are held — cancelling is the honest action, not vanishing', async () => {
    findEventById.mockResolvedValue({ ...draft, status: 1, seats_taken: 2 });

    await expect(deleteEvent(5n, actor)).rejects.toMatchObject({
      messageKey: 'event.hasRegistrations',
    });

    expect(updateEvent).not.toHaveBeenCalled();
  });
});
