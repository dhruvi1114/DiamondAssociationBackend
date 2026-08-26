import { SettingValueType } from '@prisma/client';

import { AUDIT_ACTIONS } from '@constant/audit.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { prisma } from '@db/prisma';
import { writeAudit } from '@helpers/audit';
import { invalidateSetting } from '@helpers/settings';
import { AppError } from '@utils/appError';

import { EDITABLE_SETTINGS, type UpdateSettingsInput } from './settings.types';

interface Actor {
  id: bigint;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

const audited = (actor: Actor) => ({
  actorType: 'ADMIN' as const,
  actorId: actor.id,
  ip: actor.ip,
  userAgent: actor.userAgent,
  requestId: actor.requestId,
});

/**
 * Every setting, in the order the screen shows them.
 *
 * `editable` is computed rather than stored: it says whether THIS API will
 * accept a write, which is a property of the validation allow-list, not of the
 * row. A setting the screen cannot edit is still worth returning — an admin
 * looking for a value wants to see it whether or not they may change it.
 */
export const listSettings = async () => {
  const rows = await prisma.systemSetting.findMany({
    orderBy: [{ group: 'asc' }, { key: 'asc' }],
    select: {
      key: true,
      value: true,
      value_type: true,
      group: true,
      description: true,
      is_public: true,
      updatedAt: true,
    },
  });

  return rows.map((row) => ({ ...row, editable: row.key in EDITABLE_SETTINGS }));
};

/**
 * The rows flagged `is_public`, for callers with no session.
 *
 * `is_public` is the whole allow-list and it is stored on the row, so making a
 * setting public is a data decision an admin can see in the settings table
 * rather than a code change. Nothing here is derived or filtered again: a row
 * marked public is one the platform already prints on invoices or shows to
 * members, and `organisation.name` says as much in its own description — "used
 * in emails, invoices and page titles".
 *
 * Deliberately narrower than `listSettings`: no `description`, no `updatedAt`,
 * no `editable`. An unauthenticated caller needs the value, not the commentary
 * written for the admin who maintains it.
 */
export const listPublicSettings = async () => {
  const rows = await prisma.systemSetting.findMany({
    where: { is_public: true },
    orderBy: [{ group: 'asc' }, { key: 'asc' }],
    select: { key: true, value: true, value_type: true },
  });

  return rows;
};

/**
 * Apply a batch of changes, all or nothing.
 *
 * The transaction is the point. The screen saves several fields at once, and a
 * partial apply would leave the admin looking at a form where some rows saved
 * and some did not, with no way to tell which — worse than a clean failure they
 * can retry.
 */
export const updateSettings = async (input: UpdateSettingsInput, actor: Actor) => {
  const keys = input.settings.map((entry) => entry.key);

  if (new Set(keys).size !== keys.length) {
    throw new AppError({
      errorType: ERROR_TYPES.INVALID_REQUEST,
      messageKey: 'settings.duplicateKey',
    });
  }

  const current = await prisma.systemSetting.findMany({
    where: { key: { in: keys } },
    select: { key: true, value: true, value_type: true },
  });
  const before = new Map(current.map((row) => [row.key, row]));

  /*
    Validate the whole batch before writing any of it. Validating inside the
    write loop would roll back on the second bad value, which is correct but
    reports one failure at a time — the admin fixes a field, presses Save, and
    is told about the next one.
  */
  const changes: { key: string; value: string; previous: string }[] = [];

  for (const entry of input.settings) {
    const rule = EDITABLE_SETTINGS[entry.key];

    if (!rule) {
      throw new AppError({
        errorType: ERROR_TYPES.INVALID_REQUEST,
        messageKey: 'settings.notEditable',
        details: { key: entry.key },
      });
    }

    const existing = before.get(entry.key);

    if (!existing) {
      throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'settings.notFound' });
    }

    const parsed = rule.safeParse(entry.value);

    if (!parsed.success) {
      throw new AppError({
        errorType: ERROR_TYPES.INVALID_REQUEST,
        messageKey: parsed.error.issues[0]?.message ?? 'validation.invalid',
        details: { key: entry.key },
      });
    }

    // A no-op write would still produce an audit row saying the value changed.
    if (parsed.data === existing.value) continue;

    changes.push({ key: entry.key, value: parsed.data, previous: existing.value });
  }

  if (changes.length === 0) return { updated: 0 };

  await prisma.$transaction(async (tx) => {
    for (const change of changes) {
      await tx.systemSetting.update({
        where: { key: change.key },
        data: { value: change.value },
      });

      await writeAudit(tx, {
        ...audited(actor),
        action: AUDIT_ACTIONS.SETTING_UPDATED,
        entityName: 'SystemSettings',
        before: { key: change.key, value: change.previous },
        after: { key: change.key, value: change.value },
      });
    }
  });

  /*
    Drop each changed key from the read cache. Without this the admin saves,
    sees the new value in the form, and the rest of the app keeps using the old
    one for up to a minute — the kind of bug that gets diagnosed as "the save
    did not work".
  */
  changes.forEach((change) => invalidateSetting(change.key));

  return { updated: changes.length };
};

export const SETTING_VALUE_TYPES = SettingValueType;
