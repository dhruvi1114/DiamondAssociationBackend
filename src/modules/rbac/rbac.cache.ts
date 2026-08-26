import { PERMISSION_CACHE_TTL_MS } from '@constant/auth.constant';
import { prisma } from '@db/prisma';
import { logger } from '@logger/logger';
import { loadAdminAccess, type AdminAccess } from '@modules/rbac/rbac.repository';

/**
 * The 60-second permission cache (rbac.md §1).
 *
 * The rule it implements: **the middleware never trusts the token's permission
 * claim.** An admin access token lives 30 minutes and carries only a *hash* of
 * the permission set; the set itself is re-read from the database here. So when
 * a super admin revokes `application.approve`, the holder loses it within 60
 * seconds without re-logging in — the property M1's definition of done requires
 * and the reason `perms[]` is a hash in the token rather than a list.
 *
 * Why a cache at all: without one, every admin request pays a five-table join.
 * Why 60 seconds: it is the documented number, and it bounds the window in which
 * a revoked permission still works. Deleting the entry outright on a role change
 * we perform ourselves (see `invalidateAdminAccess`) makes our own writes
 * immediate; the TTL is the backstop for changes made anywhere else — a DBA, a
 * seed re-run, a future bulk tool.
 *
 * Process-local `Map`, deliberately. With a single API instance (ADR-009) that is
 * correct; with several, each would hold its own copy and the bound stays 60
 * seconds per instance, which is still the promise. A shared store would be the
 * change if instances multiply — the same conversation as OQ-14's rate-limit
 * store, and it belongs in that decision rather than pre-empted here.
 */

interface CacheEntry {
  access: AdminAccess;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * A miss must not be able to grow unbounded from an attacker cycling ids — but
 * only authenticated ids ever reach this map, so the bound is the number of real
 * staff accounts. The sweep exists for long-lived processes, not for safety.
 */
const MAX_ENTRIES = 500;

const sweepExpired = (now: number): void => {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }
};

/**
 * Live access for one staff account, from cache when fresh and from the database
 * otherwise. `null` means the account is gone or soft-deleted; the caller must
 * treat that as an invalid session, not as "no permissions".
 */
export const getAdminAccess = async (adminUserId: bigint): Promise<AdminAccess | null> => {
  const key = adminUserId.toString();
  const now = Date.now();
  const cached = cache.get(key);

  if (cached && cached.expiresAt > now) {
    return cached.access;
  }

  const access = await loadAdminAccess(prisma, adminUserId);

  if (!access) {
    cache.delete(key);
    return null;
  }

  if (cache.size >= MAX_ENTRIES) {
    sweepExpired(now);
  }

  cache.set(key, { access, expiresAt: now + PERMISSION_CACHE_TTL_MS });

  return access;
};

/**
 * Drop one admin's cached set — called after we change their roles or status, so
 * an action taken in the admin UI is visible on the very next request instead of
 * up to a minute later. Never a substitute for the TTL: a change made outside
 * this process still has to expire naturally.
 */
export const invalidateAdminAccess = (adminUserId: bigint): void => {
  const deleted = cache.delete(adminUserId.toString());

  if (deleted) {
    logger.debug('rbac.cacheInvalidated', { adminUserId: adminUserId.toString() });
  }
};

/** Exposed for the self-test suite, which needs a known-cold cache. */
export const clearAdminAccessCache = (): void => {
  cache.clear();
};

/**
 * Does this access set satisfy the requirement?
 *
 * `is_super_admin` bypasses the check entirely (rbac.md §2). The bypass is
 * reported back to the caller so it can be audited rather than being invisible.
 */
export const evaluate = (
  access: AdminAccess,
  required: string[],
  mode: 'any' | 'all',
): { granted: boolean; viaSuperAdmin: boolean } => {
  if (access.is_super_admin) {
    return { granted: true, viaSuperAdmin: true };
  }

  const held = new Set(access.permissions);
  const granted =
    mode === 'all'
      ? required.every((code) => held.has(code))
      : required.some((code) => held.has(code));

  return { granted, viaSuperAdmin: false };
};
