import { describe, expect, it, vi, beforeEach } from 'vitest';

const findFirst = vi.fn();
const update = vi.fn();
const auditCreate = vi.fn();
const put = vi.fn();
const exists = vi.fn();
const getStream = vi.fn();
const del = vi.fn();

vi.mock('@db/prisma', () => {
  const client = {
    member: {
      findFirst: (...a: unknown[]) => findFirst(...a),
      update: (...a: unknown[]) => update(...a),
    },
    auditLog: { create: (...a: unknown[]) => auditCreate(...a) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  };

  return { prisma: client };
});

vi.mock('@helpers/storage', async () => {
  const actual = await vi.importActual<typeof import('@helpers/storage')>('@helpers/storage');

  return {
    ...actual,
    getStorage: () => ({
      put: (...a: unknown[]) => put(...a),
      exists: (...a: unknown[]) => exists(...a),
      getStream: (...a: unknown[]) => getStream(...a),
      delete: (...a: unknown[]) => del(...a),
    }),
  };
});

const { putOwnLogo, clearOwnLogo, openPublicLogo, logoMimeForKey, LOGO_MAX_BYTES } =
  await import('@modules/member/member.logo.service');

const ACTOR = { id: 1n, ip: null, userAgent: null, requestId: null };

/** A real 8-byte PNG signature — the sniffer reads bytes, not filenames. */
const png = (size = 64): Buffer =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(Math.max(size - 8, 0)),
  ]);

beforeEach(() => {
  vi.clearAllMocks();
  findFirst.mockResolvedValue({ id: 7n, logo_path: null });
  update.mockResolvedValue({ id: 7n, logo_path: 'members/7/abc.png' });
  auditCreate.mockResolvedValue({});
  put.mockResolvedValue({ key: 'members/7/abc.png', size: 64, checksum: 'x' });
  exists.mockResolvedValue(true);
  del.mockResolvedValue(undefined);
});

describe('member logo upload', () => {
  it('accepts a PNG and answers with a URL rather than a storage key', async () => {
    const result = await putOwnLogo(7n, { buffer: png(), originalname: 'logo.png' }, ACTOR);

    expect(result).toEqual({ logo_url: '/api/v1/public/members/7/logo' });
  });

  /**
   * The extension comes from the sniffed bytes, never the upload's filename.
   * That is what lets the serving endpoint trust a key's extension: it is
   * something this server decided, so it cannot disagree with the content.
   */
  it('names the stored file from the sniffed type, not the filename', async () => {
    await putOwnLogo(7n, { buffer: png(), originalname: 'evil.svg' }, ACTOR);

    const key = (put.mock.calls[0] as unknown[])[0] as string;

    expect(key.endsWith('.png')).toBe(true);
    expect(key).not.toContain('evil');
  });

  it('refuses a file that is not an image the sniffer recognises', async () => {
    const html = Buffer.from('<script>alert(1)</script>');

    await expect(
      putOwnLogo(7n, { buffer: html, originalname: 'logo.png' }, ACTOR),
    ).rejects.toThrow();
    expect(put).not.toHaveBeenCalled();
  });

  it('refuses a file over the size ceiling before storing anything', async () => {
    await expect(
      putOwnLogo(7n, { buffer: png(LOGO_MAX_BYTES + 1), originalname: 'logo.png' }, ACTOR),
    ).rejects.toThrow();
    expect(put).not.toHaveBeenCalled();
  });

  /** Replacing overwrites: a logo carries no evidentiary weight to version. */
  it('deletes the previous file only after the row stops pointing at it', async () => {
    findFirst.mockResolvedValue({ id: 7n, logo_path: 'members/7/old.png' });

    await putOwnLogo(7n, { buffer: png(), originalname: 'logo.png' }, ACTOR);

    expect(update).toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith('members/7/old.png');
  });
});

describe('member logo removal', () => {
  it('is a no-op when there is no logo', async () => {
    const result = await clearOwnLogo(7n, ACTOR);

    expect(result).toEqual({ logo_url: null });
    expect(update).not.toHaveBeenCalled();
  });

  it('clears the row and removes the file', async () => {
    findFirst.mockResolvedValue({ id: 7n, logo_path: 'members/7/old.png' });

    await clearOwnLogo(7n, ACTOR);

    expect(update).toHaveBeenCalledWith({ where: { id: 7n }, data: { logo_path: null } });
    expect(del).toHaveBeenCalledWith('members/7/old.png');
  });
});

/**
 * The rule the public endpoint rests on. Every condition is in the WHERE clause
 * rather than checked afterwards: a member who left the directory answers 404
 * identically to an id that was never issued, because a 403 would confirm they
 * are a member.
 */
describe('serving a logo to the public', () => {
  it('selects only a live, ACTIVE, directory-visible member that has a logo', async () => {
    findFirst.mockResolvedValue({ logo_path: 'members/7/abc.png' });

    await openPublicLogo(7n);

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: 7n,
        deletedAt: null,
        status: 'ACTIVE',
        directory_visible: true,
        logo_path: { not: null },
      },
      select: { logo_path: true },
    });
  });

  it('404s when no row matches', async () => {
    findFirst.mockResolvedValue(null);

    await expect(openPublicLogo(7n)).rejects.toThrow();
  });

  it('404s when the row points at bytes that are gone', async () => {
    findFirst.mockResolvedValue({ logo_path: 'members/7/abc.png' });
    exists.mockResolvedValue(false);

    await expect(openPublicLogo(7n)).rejects.toThrow();
  });

  it('refuses to guess a content type it does not recognise', async () => {
    expect(logoMimeForKey('members/7/abc.png')).toBe('image/png');
    expect(logoMimeForKey('members/7/abc.svg')).toBeNull();
    expect(logoMimeForKey('members/7/abc')).toBeNull();
  });
});
