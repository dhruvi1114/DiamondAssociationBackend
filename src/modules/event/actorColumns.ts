/**
 * Who last touched a row.
 *
 * `updated_by_user_id` and `updated_by_admin_id` are guarded by a CHECK allowing
 * at most one to be set — the row records *the* last actor, not every actor that
 * ever touched it. The columns are sticky, so setting one without clearing the
 * other leaves both populated and the write is refused.
 *
 * That is easy to forget at each call site and impossible to forget through
 * these helpers, so every event-module write goes through them. The full history
 * of who did what lives in `AuditLogs`; these two columns answer only "who
 * last".
 */

export interface TouchColumns {
  updated_by_user_id: bigint | null;
  updated_by_admin_id: bigint | null;
}

/** A member login made this change. */
export const touchedByMember = (userId: bigint | null): TouchColumns => ({
  updated_by_user_id: userId,
  updated_by_admin_id: null,
});

/** A staff account made this change. */
export const touchedByAdmin = (adminId: bigint): TouchColumns => ({
  updated_by_user_id: null,
  updated_by_admin_id: adminId,
});

/** A job made this change — the expiry sweep, for instance. Both null. */
export const touchedBySystem = (): TouchColumns => ({
  updated_by_user_id: null,
  updated_by_admin_id: null,
});
