import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Bug fix: a storage failure while copying one KYC document onto the member
 * record must NOT propagate out of `adoptApplicationDocuments` — and therefore
 * must not roll back the approval transaction it runs inside of (docstring on
 * the function, ~L101-125).
 */

const { loggerError } = vi.hoisted(() => ({
  loggerError: vi.fn(),
}));
vi.mock('@logger/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: loggerError, debug: vi.fn() },
}));

const put = vi.fn();
const getStream = vi.fn();
vi.mock('@helpers/storage', async () => {
  const actual = await vi.importActual<typeof import('@helpers/storage')>('@helpers/storage');
  return {
    ...actual,
    // `storage.current` is a getter closed over the ORIGINAL module's internal
    // `getStorage`, so overriding the `getStorage` export (as other tests do)
    // never reaches it — `storage` itself has to be replaced.
    storage: {
      current: {
        put: (...a: unknown[]) => put(...a),
        getStream: (...a: unknown[]) => getStream(...a),
        exists: vi.fn(),
        delete: vi.fn(),
      },
    },
  };
});

const { adoptApplicationDocuments } = await import('@modules/application/activation.service');

const APPLICATION = { id: 501n } as unknown as Parameters<typeof adoptApplicationDocuments>[1];
const MEMBER_ID = 77n;

/** Two verified documents: a GST certificate and a PAN card, different types. */
const rows = [
  {
    id: 1n,
    application_id: 501n,
    document_type_id: 10n,
    side: 'SINGLE',
    version: 1,
    file_path: 'applications/501/10/gst.pdf',
    original_name: 'gst.pdf',
    mime_type: 'application/pdf',
    size_bytes: 1000n,
    checksum_sha256: 'a'.repeat(64),
    verification_status: 'VERIFIED',
    verified_by_admin_id: 9n,
    verified_at: new Date(),
    remarks: null,
  },
  {
    id: 2n,
    application_id: 501n,
    document_type_id: 20n,
    side: 'SINGLE',
    version: 1,
    file_path: 'applications/501/20/pan.pdf',
    original_name: 'pan.pdf',
    mime_type: 'application/pdf',
    size_bytes: 900n,
    checksum_sha256: 'b'.repeat(64),
    verification_status: 'VERIFIED',
    verified_by_admin_id: 9n,
    verified_at: new Date(),
    remarks: null,
  },
];

const memberDocumentCreate = vi.fn();
const fakeTx = {
  applicationDocument: { findMany: vi.fn().mockResolvedValue(rows) },
  memberDocument: {
    findFirst: vi.fn().mockResolvedValue(null), // neither already adopted
    create: (...a: unknown[]) => memberDocumentCreate(...a),
  },
} as unknown as Parameters<typeof adoptApplicationDocuments>[0];

beforeEach(() => {
  vi.clearAllMocks();
  fakeTx.applicationDocument.findMany = vi.fn().mockResolvedValue(rows) as never;
  fakeTx.memberDocument.findFirst = vi.fn().mockResolvedValue(null) as never;
  memberDocumentCreate.mockResolvedValue({ id: 1n });
  getStream.mockResolvedValue('stream' as never);
  put.mockResolvedValue({ key: 'members/77/x', size: 1000, checksum: 'c' });
});

describe('adoptApplicationDocuments — a copy failure does not fail the approval', () => {
  it('copies the documents that succeed and skips the one that fails, without throwing', async () => {
    // First document's storage write fails (e.g. disk/S3 outage); the second's succeeds.
    put
      .mockRejectedValueOnce(new Error('ENOSPC: no space left on device'))
      .mockResolvedValueOnce({ key: 'members/77/20/pan.pdf', size: 900, checksum: 'c' });

    const result = await adoptApplicationDocuments(fakeTx, APPLICATION, MEMBER_ID);

    // Did not throw — the caller's transaction is never touched by this failure.
    expect(result.copied).toBe(1);
    expect(result.keys).toEqual(['members/77/20/pan.pdf']);
    expect(memberDocumentCreate).toHaveBeenCalledTimes(1);
  });

  it('logs the failure with application id and member id as strings, and no file path or personal data', async () => {
    put.mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));
    put.mockResolvedValueOnce({ key: 'members/77/20/pan.pdf', size: 900, checksum: 'c' });

    await adoptApplicationDocuments(fakeTx, APPLICATION, MEMBER_ID);

    expect(loggerError).toHaveBeenCalledTimes(1);
    const [event, meta] = loggerError.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe('application.documentCopyFailed');
    expect(meta.applicationId).toBe('501');
    expect(meta.memberId).toBe('77');
    expect(meta.detail).toContain('ENOSPC');
    // No file path, filename, or checksum leaked into the log.
    expect(JSON.stringify(meta)).not.toMatch(/gst\.pdf|pan\.pdf|applications\/501/);
  });

  it('when every copy fails, still returns cleanly with nothing adopted (the "nothing copied" shape)', async () => {
    put.mockRejectedValue(new Error('storage unavailable'));

    const result = await adoptApplicationDocuments(fakeTx, APPLICATION, MEMBER_ID);

    expect(result).toEqual({ copied: 0, keys: [] });
    expect(memberDocumentCreate).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledTimes(2);
  });

  it('on full success, behaves exactly as before: nothing caught, nothing logged', async () => {
    const result = await adoptApplicationDocuments(fakeTx, APPLICATION, MEMBER_ID);

    expect(result.copied).toBe(2);
    expect(result.keys).toHaveLength(2);
    expect(memberDocumentCreate).toHaveBeenCalledTimes(2);
    expect(loggerError).not.toHaveBeenCalled();
  });
});
