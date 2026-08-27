import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every router must be mounted on its own namespace, never on the API root.
 *
 * This is a guard against one specific and very expensive mistake, made once
 * already: `eventMemberRouter` was mounted at `/api/v1` rather than
 * `/api/v1/events`.
 *
 * `router.use(path, sub)` only checks that the request PATH STARTS WITH `path`,
 * so a router mounted at the root runs for every request in the API — and this
 * one opens with a path-less `use(authenticate)`, a member-audience check.
 * Everything registered after it in `index.ts` was answered by that guard
 * before reaching its own router: an admin's token came back "wrong audience"
 * on `/admin/applications`, and the deliberately session-free correction links
 * under `/public` began demanding a login.
 *
 * Nothing about that failure is visible in the router being mounted, in the
 * router being shadowed, or in either one's tests — only in the mount line. So
 * the mount lines are what this reads.
 *
 * Source text rather than the live router: importing `index.ts` pulls in every
 * controller, service and Prisma client in the application, and a test that
 * needs a database to prove a routing rule will be deleted the first time it is
 * inconvenient.
 */
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8');

const mounts = [...source.matchAll(/router\.use\(\s*([^,]+),\s*(\w+)\s*\)/g)].map(
  ([, path, name]) => ({ path: path.trim(), router: name }),
);

describe('route mounts', () => {
  it('finds the mount lines at all — the regex above must not silently match nothing', () => {
    expect(mounts.length).toBeGreaterThan(10);
  });

  it('mounts no router on the bare API version prefix', () => {
    const atRoot = mounts.filter(
      (mount) => mount.path === 'END_POINTS.V1' || mount.path === '`${END_POINTS.V1}`',
    );

    expect(atRoot).toEqual([]);
  });

  it('mounts the member event router under /events', () => {
    const mount = mounts.find((entry) => entry.router === 'eventMemberRouter');

    expect(mount?.path).toBe('`${END_POINTS.V1}${END_POINTS.EVENTS}`');
  });
});
