import { describe, expect, it, vi, beforeEach } from 'vitest';

const memberFindMany = vi.fn();
const memberCount = vi.fn();
const findMemberByUserId = vi.fn();
const getBooleanSetting = vi.fn();

vi.mock('@db/prisma', () => ({
  prisma: {
    member: {
      findMany: (...a: unknown[]) => memberFindMany(...a),
      count: (...a: unknown[]) => memberCount(...a),
    },
  },
}));
vi.mock('@modules/member/member.repository', () => ({
  findMemberByUserId: (...a: unknown[]) => findMemberByUserId(...a),
}));
vi.mock('@modules/member/member.logo.service', () => ({
  openPublicLogo: vi.fn(),
}));
vi.mock('@helpers/settings', async () => {
  const actual = await vi.importActual<typeof import('@helpers/settings')>('@helpers/settings');

  return { ...actual, getBooleanSetting: (...a: unknown[]) => getBooleanSetting(...a) };
});

const service = await import('@modules/directory/directory.service');

beforeEach(() => {
  vi.clearAllMocks();
  findMemberByUserId.mockResolvedValue({ id: 1n, status: 'ACTIVE' });
  getBooleanSetting.mockResolvedValue(true);
  memberFindMany.mockResolvedValue([]);
  memberCount.mockResolvedValue(0);
});

const whereOf = () => memberFindMany.mock.calls[0][0].where as Record<string, unknown>;

describe('directory listing', () => {
  it('only ever lists live, ACTIVE, consenting companies', async () => {
    await service.list(7n, { page: 1 });

    expect(whereOf()).toMatchObject({
      deletedAt: null,
      status: 'ACTIVE',
      directory_visible: true,
    });
  });

  it('caps the page at 24 rows however the caller asks', async () => {
    await service.list(7n, { page: 1, limit: 10000 } as never);

    expect(memberFindMany.mock.calls[0][0].take).toBe(24);
  });

  it('searches the trading name, the registered name and the description', async () => {
    await service.list(7n, { q: 'spices', page: 1 });

    const and = (whereOf() as { AND: { OR?: unknown[] }[] }).AND;
    const or = JSON.stringify(and.find((clause) => clause.OR)?.OR);

    expect(or).toContain('company_name');
    expect(or).toContain('legal_name');
    expect(or).toContain('about');
  });

  it('never selects the registered name it searched', async () => {
    await service.list(7n, { q: 'spices', page: 1 });

    const select = memberFindMany.mock.calls[0][0].select as Record<string, unknown>;

    expect(select).not.toHaveProperty('legal_name');
    expect(select).not.toHaveProperty('gst_number');
    expect(select).not.toHaveProperty('pan_number');
    expect(select).not.toHaveProperty('iec_code');
  });

  it('treats an injection string as an ordinary search term', async () => {
    await service.list(7n, { q: '\'; DROP TABLE "Members"; --', page: 1 });

    expect(memberFindMany).toHaveBeenCalledTimes(1);
    expect(memberCount).toHaveBeenCalledTimes(1);
  });

  it('refuses everyone when the association switches the directory off', async () => {
    getBooleanSetting.mockResolvedValue(false);

    await expect(service.list(7n, { page: 1 })).rejects.toMatchObject({
      details: { reason: 'DIRECTORY_OFF' },
    });
    expect(memberFindMany).not.toHaveBeenCalled();
  });

  /*
    Looking and being listed are different questions. A member who opted out
    still pays, and still gets the benefit they paid for.
  */
  it('lets a member who opted out of being listed still search', async () => {
    findMemberByUserId.mockResolvedValue({ id: 1n, status: 'ACTIVE', directory_visible: false });

    await expect(service.list(7n, { page: 1 })).resolves.toMatchObject({ total: 0 });
  });

  it('refuses a PENDING company before it queries anything', async () => {
    findMemberByUserId.mockResolvedValue({ id: 1n, status: 'PENDING' });

    await expect(service.list(7n, { page: 1 })).rejects.toMatchObject({
      details: { reason: 'PAYMENT_PENDING' },
    });
    expect(memberFindMany).not.toHaveBeenCalled();
  });

  it('pages by 24 rather than by whatever the caller sent', async () => {
    await service.list(7n, { page: 3 });

    expect(memberFindMany.mock.calls[0][0].skip).toBe(48);
  });

  it('reports at least one page even when nothing is listed', async () => {
    await expect(service.list(7n, { page: 1 })).resolves.toMatchObject({ totalPages: 1 });
  });
});

describe('directory detail', () => {
  it('answers a slug with no id as not found, without querying', async () => {
    const memberFindFirst = vi.fn();

    await expect(service.detail(7n, 'shreeji-exports')).resolves.toBeNull();
    expect(memberFindFirst).not.toHaveBeenCalled();
  });

  it('refuses an EXPIRED caller before resolving any slug', async () => {
    findMemberByUserId.mockResolvedValue({ id: 1n, status: 'EXPIRED' });

    await expect(service.detail(7n, 'shreeji-exports-42')).rejects.toMatchObject({
      details: { reason: 'EXPIRED' },
    });
  });
});
