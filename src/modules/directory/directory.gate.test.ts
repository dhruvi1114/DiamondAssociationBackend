import { describe, expect, it, vi, beforeEach } from 'vitest';

const findMemberByUserId = vi.fn();

vi.mock('@db/prisma', () => ({ prisma: {} }));
vi.mock('@modules/member/member.repository', () => ({
  findMemberByUserId: (...a: unknown[]) => findMemberByUserId(...a),
}));

const { assertDirectoryAccess } = await import('@modules/directory/directory.gate');
const { DIRECTORY_DENY } = await import('@modules/directory/directory.constants');

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Holding a login is not membership. Anyone can complete the signup form in two
 * minutes; if that were the gate, the contact list would be free to whoever
 * asked, and every lapsed member would keep the benefit for ever.
 */
describe('assertDirectoryAccess', () => {
  it('admits an ACTIVE company', async () => {
    findMemberByUserId.mockResolvedValue({ id: 42n, status: 'ACTIVE' });

    await expect(assertDirectoryAccess(7n)).resolves.toEqual({ memberId: 42n });
  });

  it('refuses a login that belongs to no company', async () => {
    findMemberByUserId.mockResolvedValue(null);

    await expect(assertDirectoryAccess(7n)).rejects.toMatchObject({
      details: { reason: DIRECTORY_DENY.NO_MEMBERSHIP },
    });
  });

  it.each([
    ['DRAFT', DIRECTORY_DENY.PAYMENT_PENDING],
    ['PENDING', DIRECTORY_DENY.PAYMENT_PENDING],
    ['EXPIRED', DIRECTORY_DENY.EXPIRED],
    ['SUSPENDED', DIRECTORY_DENY.SUSPENDED],
    ['TERMINATED', DIRECTORY_DENY.EXPIRED],
  ])('refuses a %s company with reason %s', async (status, reason) => {
    findMemberByUserId.mockResolvedValue({ id: 42n, status });

    await expect(assertDirectoryAccess(7n)).rejects.toMatchObject({
      details: { reason },
    });
  });

  /*
    The status is re-read per call, never cached and never taken from a token.
    A member suspended five minutes ago must fail their next request, not wait
    for a token to expire.
  */
  it('re-reads the status on every call', async () => {
    findMemberByUserId.mockResolvedValue({ id: 42n, status: 'ACTIVE' });
    await assertDirectoryAccess(7n);
    await assertDirectoryAccess(7n);

    expect(findMemberByUserId).toHaveBeenCalledTimes(2);
  });

  it('never puts a company name in the refusal', async () => {
    findMemberByUserId.mockResolvedValue({
      id: 42n,
      status: 'EXPIRED',
      company_name: 'Kiran Traders',
    });

    const error = await assertDirectoryAccess(7n).catch((e: unknown) => e);

    expect(JSON.stringify(error)).not.toContain('Kiran Traders');
  });
});
