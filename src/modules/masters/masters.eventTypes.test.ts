import { describe, expect, it, vi, beforeEach } from 'vitest';

const eventTypeFindFirst = vi.fn();
const eventTypeUpdate = vi.fn();
const eventCount = vi.fn();
const auditCreate = vi.fn();

vi.mock('@db/prisma', () => ({
  prisma: {
    eventType: {
      findFirst: (...a: unknown[]) => eventTypeFindFirst(...a),
      update: (...a: unknown[]) => eventTypeUpdate(...a),
      create: vi.fn(),
    },
    event: { count: (...a: unknown[]) => eventCount(...a) },
    auditLog: { create: (...a: unknown[]) => auditCreate(...a) },
  },
}));

const { deleteEventType } = await import('@modules/masters/masters.registration.service');

const actor = { id: 1n, ip: null, userAgent: null, requestId: null };

beforeEach(() => {
  vi.clearAllMocks();
  eventTypeFindFirst.mockResolvedValue({ id: 7n, code: 'SEMINAR', name: 'Seminar' });
  eventTypeUpdate.mockResolvedValue({ id: 7n });
  auditCreate.mockResolvedValue({});
});

/**
 * A type an event still carries must not be removable.
 *
 * Deleting it could only orphan those events or silently retype them, and a
 * masters screen has no business doing either to the event history. The refusal
 * carries the count so the message can say what is using it.
 */
describe('deleting an event type', () => {
  it('is refused while any event still carries it', async () => {
    eventCount.mockResolvedValue(3);

    await expect(deleteEventType(7n, actor)).rejects.toMatchObject({
      messageKey: 'masters.eventTypeInUse',
    });

    expect(eventTypeUpdate).not.toHaveBeenCalled();
  });

  it('soft-deletes when nothing uses it, and writes an audit row', async () => {
    eventCount.mockResolvedValue(0);

    await deleteEventType(7n, actor);

    const data = eventTypeUpdate.mock.calls[0][0].data as { deletedAt: Date };

    // Soft, not hard: a code is unique across deleted rows too, so re-adding
    // "Seminar" later has to be able to revive this row rather than collide.
    expect(data.deletedAt).toBeInstanceOf(Date);
    expect(auditCreate).toHaveBeenCalled();
  });

  it('counts only live events, never soft-deleted ones', async () => {
    eventCount.mockResolvedValue(0);

    await deleteEventType(7n, actor);

    expect(eventCount).toHaveBeenCalledWith({
      where: { event_type_id: 7n, deletedAt: null },
    });
  });
});
