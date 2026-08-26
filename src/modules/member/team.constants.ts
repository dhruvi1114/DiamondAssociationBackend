/**
 * Integer enum codes for the company team tables.
 *
 * Tables created from M7 onward store enums as `smallint` codes rather than
 * Postgres native enums (2026-08-26 event-module schema spec, section 0.1).
 * Codes are append-only: a value is never renumbered or reused, because old rows
 * keep whatever number was written into them.
 */

export const MEMBER_ROLE = {
  /** The company's primary login. Exactly one per member, enforced by a partial unique index. */
  OWNER: 0,
  /** Someone the owner invited. Finer permissions are deliberately deferred. */
  TEAM: 1,
} as const;

export type MemberRole = (typeof MEMBER_ROLE)[keyof typeof MEMBER_ROLE];

export const MEMBER_USER_STATUS = {
  /** Invite email sent; the password is not set yet. Cannot act for the company. */
  INVITED: 0,
  /** Password set, login works. */
  ACTIVE: 1,
  /** Switched off by an owner. Kept for history rather than deleted. */
  DEACTIVATED: 2,
} as const;

export type MemberUserStatus = (typeof MEMBER_USER_STATUS)[keyof typeof MEMBER_USER_STATUS];
