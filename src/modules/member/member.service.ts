import { InvoiceStatus, MemberStatus, Prisma, TermStatus } from '@prisma/client';
import { AUDIT_ACTIONS } from '@constant/audit.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { prisma } from '@db/prisma';
import { writeAudit } from '@helpers/audit';
import * as repo from '@modules/member/member.repository';
import { APPROVAL_REQUIRED_FIELDS } from '@modules/member/member.types';
import type {
  AddressInput,
  AdminUpdateMemberInput,
  ChangeCategoryInput,
  ContactInput,
  CreateChangeRequestInput,
  ListMembersQuery,
  UpdateProfileInput,
} from '@modules/member/member.types';
import { AppError } from '@utils/appError';

/**
 * Business rules for the member record (M3).
 *
 * Three of them shape everything here:
 *
 *  1. **The record exists before the membership does.** A signed-up user gets a
 *     DRAFT member row the first time they open their profile (ADR-016), so
 *     contacts and KYC have something to attach to. M4's application links to
 *     this row rather than creating a second one.
 *  2. **Identity fields go through an approver** (A-11). A member editing their
 *     own GST number silently would change which company the membership belongs
 *     to.
 *  3. **Every status change carries a reason and lands in history.** The member
 *     is told what happened and why.
 */

interface Actor {
  id: bigint;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

const notFound = (key: string): AppError =>
  new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: key });

const conflict = (key: string, details?: Record<string, unknown>): AppError =>
  new AppError({
    errorType: ERROR_TYPES.CONFLICT,
    messageKey: key,
    ...(details ? { details } : {}),
  });

const memberAudit = (actor: Actor) => ({
  actorType: 'MEMBER' as const,
  actorId: actor.id,
  ip: actor.ip,
  userAgent: actor.userAgent,
  requestId: actor.requestId,
});

const adminAudit = (actor: Actor) => ({
  actorType: 'ADMIN' as const,
  actorId: actor.id,
  ip: actor.ip,
  userAgent: actor.userAgent,
  requestId: actor.requestId,
});

/** A duplicate GST/IEC is a partial unique index, not a service check — two
 *  members registering the same number at once must not both succeed. */
const isUniqueViolation = (error: unknown, fragment: string): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002' &&
  JSON.stringify(error.meta ?? {}).includes(fragment);

/* -------------------------------------------------------------------------- */
/* The member's own record                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Fetch the caller's company, creating the DRAFT row on first access.
 *
 * Auto-provisioning here rather than at signup keeps the identity module free of
 * membership concepts, and means a user who never starts an application never
 * gets an empty company record.
 */
export const getOrCreateOwnMember = async (userId: bigint, actor: Actor) => {
  const existing = await repo.findMemberByUserId(prisma, userId);
  if (existing) return existing;

  // Read the name here rather than taking it from the token: a JWT claim is a
  // snapshot from sign-in time, and this value becomes the company's first
  // display name.
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { id: true, full_name: true },
  });
  if (!user) throw notFound('auth.userNotFound');

  try {
    return await provisionMember(user, actor);
  } catch (error) {
    // Two first-page requests race here: both read no member, both insert, and
    // `primary_user_id @unique` fails one of them. The loser is not an error —
    // the row it wanted now exists, written by the request it lost to.
    if (!isUniqueViolation(error, 'primary_user_id')) throw error;

    const won = await repo.findMemberByUserId(prisma, userId);
    if (!won) throw error;

    return won;
  }
};

const provisionMember = async (user: { id: bigint; full_name: string }, actor: Actor) =>
  prisma.$transaction(async (tx) => {
    const created = await repo.createMember(tx, {
      primary_user_id: user.id,
      // Seeded from the signup name so the profile is never blank; the member
      // renames it to the trading name on their first edit.
      company_name: user.full_name,
      status: MemberStatus.DRAFT,
    });

    await repo.recordStatusChange(tx, {
      member_id: created.id,
      from_status: null,
      to_status: MemberStatus.DRAFT,
      reason: 'Member record created',
    });

    await writeAudit(tx, {
      ...memberAudit(actor),
      action: AUDIT_ACTIONS.MEMBER_CREATED,
      entityName: 'Members',
      entityId: created.id,
      after: { company_name: created.company_name, status: created.status },
    });

    return created;
  });

export const getOwnProfile = async (userId: bigint, actor: Actor) => {
  const member = await getOrCreateOwnMember(userId, actor);
  const detail = await repo.findMemberDetail(prisma, member.id);
  if (!detail) throw notFound('member.notFound');

  return detail;
};

/**
 * Self-service profile update.
 *
 * The zod schema already excludes the approval-gated fields, so anything that
 * reaches here is safe to write. Category and tier are settable while the member
 * is still DRAFT — after that, changing class is an admin action with a reason.
 */
export const updateOwnProfile = async (
  memberId: bigint,
  input: UpdateProfileInput,
  actor: Actor,
) => {
  const existing = await repo.findMemberById(prisma, memberId);
  if (!existing) throw notFound('member.notFound');

  if (input.category_ids !== undefined && existing.status !== MemberStatus.DRAFT) {
    throw conflict('member.categoryLocked');
  }

  return prisma.$transaction(async (tx) => {
    const updated = await repo.updateMember(tx, memberId, {
      ...(input.company_name !== undefined ? { company_name: input.company_name } : {}),
      ...(input.website !== undefined ? { website: input.website } : {}),
      ...(input.about !== undefined ? { about: input.about } : {}),
      ...(input.directory_visible !== undefined
        ? { directory_visible: input.directory_visible }
        : {}),
    });

    if (input.category_ids !== undefined) {
      await repo.setMemberCategories(
        tx,
        memberId,
        input.category_ids.map((id) => BigInt(id)),
      );
    }

    await writeAudit(tx, {
      ...memberAudit(actor),
      action: AUDIT_ACTIONS.MEMBER_PROFILE_UPDATED,
      entityName: 'Members',
      entityId: memberId,
      before: { company_name: existing.company_name, website: existing.website },
      after: { company_name: updated.company_name, website: updated.website },
    });

    return updated;
  });
};

/**
 * Queue a change to an identity field.
 *
 * Only the differences are stored: submitting a form with four unchanged fields
 * should not produce an approval task claiming four changes.
 */
export const requestProfileChange = async (
  memberId: bigint,
  input: CreateChangeRequestInput,
  actor: Actor,
) => {
  const member = await repo.findMemberById(prisma, memberId);
  if (!member) throw notFound('member.notFound');

  if (await repo.findOpenChangeRequest(prisma, memberId)) {
    throw conflict('member.changeRequestOpen');
  }

  const changes: Record<string, { old: unknown; new: unknown }> = {};
  for (const field of APPROVAL_REQUIRED_FIELDS) {
    const proposed = input[field as keyof CreateChangeRequestInput];
    if (proposed === undefined) continue;
    const current = member[field as keyof typeof member] ?? null;
    if ((proposed ?? null) !== current) {
      changes[field] = { old: current, new: proposed ?? null };
    }
  }

  if (Object.keys(changes).length === 0) throw conflict('member.changeRequestNoDifference');

  return prisma.$transaction(async (tx) => {
    const created = await repo.createChangeRequest(tx, {
      member_id: memberId,
      requested_by_user_id: actor.id,
      changes_json: changes as Prisma.InputJsonValue,
      reason: input.reason ?? null,
    });

    await writeAudit(tx, {
      ...memberAudit(actor),
      action: AUDIT_ACTIONS.MEMBER_CHANGE_REQUESTED,
      entityName: 'MemberProfileChangeRequests',
      entityId: created.id,
      after: { fields: Object.keys(changes) },
    });

    return created;
  });
};

export const listOwnChangeRequests = (memberId: bigint) =>
  repo.listChangeRequests(prisma, memberId);

/* -------------------------------------------------------------------------- */
/* Contacts and addresses                                                      */
/* -------------------------------------------------------------------------- */

export const listContacts = (memberId: bigint) => repo.listContacts(prisma, memberId);

export const addContact = async (memberId: bigint, input: ContactInput, actor: Actor) =>
  prisma.$transaction(async (tx) => {
    // First contact is primary whether or not the form said so — a member with
    // contacts but no primary has nobody to write to.
    const isFirst = (await repo.countContacts(tx, memberId)) === 0;
    const primary = input.is_primary || isFirst;

    if (primary) await repo.clearPrimaryContacts(tx, memberId);

    const created = await repo.createContact(tx, {
      member_id: memberId,
      name: input.name,
      designation: input.designation ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      is_primary: primary,
    });

    await writeAudit(tx, {
      ...memberAudit(actor),
      action: AUDIT_ACTIONS.MEMBER_CONTACT_ADDED,
      entityName: 'MemberContacts',
      entityId: created.id,
      after: { name: created.name, is_primary: created.is_primary },
    });

    return created;
  });

export const updateContact = async (
  memberId: bigint,
  contactId: bigint,
  input: ContactInput,
  actor: Actor,
) => {
  const existing = await repo.findContact(prisma, memberId, contactId);
  if (!existing) throw notFound('member.contactNotFound');

  return prisma.$transaction(async (tx) => {
    if (input.is_primary) await repo.clearPrimaryContacts(tx, memberId, contactId);

    const updated = await repo.updateContact(tx, contactId, {
      name: input.name,
      designation: input.designation ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      // Demoting the only primary would leave the member with none, so a lone
      // contact stays primary regardless of what the form sent.
      is_primary: input.is_primary || existing.is_primary,
    });

    await writeAudit(tx, {
      ...memberAudit(actor),
      action: AUDIT_ACTIONS.MEMBER_CONTACT_UPDATED,
      entityName: 'MemberContacts',
      entityId: contactId,
      before: { name: existing.name },
      after: { name: updated.name },
    });

    return updated;
  });
};

export const removeContact = async (memberId: bigint, contactId: bigint, actor: Actor) => {
  const existing = await repo.findContact(prisma, memberId, contactId);
  if (!existing) throw notFound('member.contactNotFound');

  if ((await repo.countContacts(prisma, memberId)) <= 1) {
    throw conflict('member.lastContact');
  }

  await prisma.$transaction(async (tx) => {
    await repo.updateContact(tx, contactId, { deletedAt: new Date(), is_primary: false });

    // Removing the primary promotes the next one, so the member never ends up
    // with contacts and nobody to write to.
    if (existing.is_primary) {
      const next = (await repo.listContacts(tx, memberId)).find((c) => c.id !== contactId);
      if (next) await repo.updateContact(tx, next.id, { is_primary: true });
    }

    await writeAudit(tx, {
      ...memberAudit(actor),
      action: AUDIT_ACTIONS.MEMBER_CONTACT_REMOVED,
      entityName: 'MemberContacts',
      entityId: contactId,
      before: { name: existing.name },
    });
  });
};

export const listAddresses = (memberId: bigint) => repo.listAddresses(prisma, memberId);

export const addAddress = async (memberId: bigint, input: AddressInput, actor: Actor) =>
  prisma.$transaction(async (tx) => {
    const isFirst = (await repo.listAddresses(tx, memberId)).length === 0;
    const primary = input.is_primary || isFirst;

    if (primary) await repo.clearPrimaryAddresses(tx, memberId);

    const created = await repo.createAddress(tx, {
      member_id: memberId,
      address_type: input.address_type,
      line1: input.line1,
      line2: input.line2 ?? null,
      city: input.city,
      state: input.state,
      country: input.country,
      pincode: input.pincode,
      is_primary: primary,
    });

    await writeAudit(tx, {
      ...memberAudit(actor),
      action: AUDIT_ACTIONS.MEMBER_ADDRESS_ADDED,
      entityName: 'MemberAddresses',
      entityId: created.id,
      after: { city: created.city, address_type: created.address_type },
    });

    return created;
  });

export const updateAddress = async (
  memberId: bigint,
  addressId: bigint,
  input: AddressInput,
  actor: Actor,
) => {
  const existing = await repo.findAddress(prisma, memberId, addressId);
  if (!existing) throw notFound('member.addressNotFound');

  return prisma.$transaction(async (tx) => {
    if (input.is_primary) await repo.clearPrimaryAddresses(tx, memberId, addressId);

    const updated = await repo.updateAddress(tx, addressId, {
      address_type: input.address_type,
      line1: input.line1,
      line2: input.line2 ?? null,
      city: input.city,
      state: input.state,
      country: input.country,
      pincode: input.pincode,
      is_primary: input.is_primary || existing.is_primary,
    });

    await writeAudit(tx, {
      ...memberAudit(actor),
      action: AUDIT_ACTIONS.MEMBER_ADDRESS_UPDATED,
      entityName: 'MemberAddresses',
      entityId: addressId,
      before: { city: existing.city },
      after: { city: updated.city },
    });

    return updated;
  });
};

export const removeAddress = async (memberId: bigint, addressId: bigint, actor: Actor) => {
  const existing = await repo.findAddress(prisma, memberId, addressId);
  if (!existing) throw notFound('member.addressNotFound');

  await prisma.$transaction(async (tx) => {
    await repo.updateAddress(tx, addressId, { deletedAt: new Date(), is_primary: false });

    if (existing.is_primary) {
      const next = (await repo.listAddresses(tx, memberId)).find((a) => a.id !== addressId);
      if (next) await repo.updateAddress(tx, next.id, { is_primary: true });
    }

    await writeAudit(tx, {
      ...memberAudit(actor),
      action: AUDIT_ACTIONS.MEMBER_ADDRESS_REMOVED,
      entityName: 'MemberAddresses',
      entityId: addressId,
      before: { city: existing.city },
    });
  });
};

/* -------------------------------------------------------------------------- */
/* Admin                                                                       */
/* -------------------------------------------------------------------------- */

export const listMembers = async (query: ListMembersQuery) => {
  const rows = await repo.listMembers(prisma, {
    search: query.search,
    statuses: query.status,
    categoryIds: query.category_id?.map(BigInt),
    tierId: query.tier_id ? BigInt(query.tier_id) : undefined,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    limit: query.limit,
    offset: (query.page - 1) * query.limit,
  });

  return { rows, total: rows.length > 0 ? Number(rows[0]!.total) : 0 };
};

export const getMemberDetail = async (id: bigint) => {
  const detail = await repo.findMemberDetail(prisma, id);
  if (!detail) throw notFound('member.notFound');

  const [history, changeRequests] = await Promise.all([
    repo.listStatusHistory(prisma, id),
    repo.listChangeRequests(prisma, id),
  ]);

  return { ...detail, status_history: history, change_requests: changeRequests };
};

export const adminUpdateMember = async (
  id: bigint,
  input: AdminUpdateMemberInput,
  actor: Actor,
) => {
  const existing = await repo.findMemberById(prisma, id);
  if (!existing) throw notFound('member.notFound');

  try {
    return await prisma.$transaction(async (tx) => {
      const updated = await repo.updateMember(tx, id, input);

      await writeAudit(tx, {
        ...adminAudit(actor),
        action: AUDIT_ACTIONS.MEMBER_UPDATED_BY_ADMIN,
        entityName: 'Members',
        entityId: id,
        before: {
          company_name: existing.company_name,
          gst_number: existing.gst_number,
          iec_code: existing.iec_code,
        },
        after: {
          company_name: updated.company_name,
          gst_number: updated.gst_number,
          iec_code: updated.iec_code,
        },
      });

      return updated;
    });
  } catch (error) {
    if (isUniqueViolation(error, 'gst_number')) throw conflict('member.gstAlreadyRegistered');
    if (isUniqueViolation(error, 'iec_code')) throw conflict('member.iecAlreadyRegistered');
    throw error;
  }
};

export const changeCategory = async (id: bigint, input: ChangeCategoryInput, actor: Actor) => {
  const existing = await repo.findMemberById(prisma, id);
  if (!existing) throw notFound('member.notFound');

  const categoryIds = input.category_ids.map((value) => BigInt(value));
  for (const categoryId of categoryIds) {
    const category = await prisma.membershipCategory.findFirst({
      where: { id: categoryId, deletedAt: null },
    });
    if (!category) throw notFound('masters.categoryNotFound');
  }

  const beforeCategories = await repo.listMemberCategories(prisma, id);

  return prisma.$transaction(async (tx) => {
    await repo.setMemberCategories(tx, id, categoryIds);

    await writeAudit(tx, {
      ...adminAudit(actor),
      action: AUDIT_ACTIONS.MEMBER_CATEGORY_CHANGED,
      entityName: 'Members',
      entityId: id,
      before: {
        category_ids: beforeCategories.map((row) => row.category.id.toString()),
      },
      after: {
        category_ids: categoryIds.map((value) => value.toString()),
        reason: input.reason,
      },
    });

    return repo.findMemberById(tx, id);
  });
};

/**
 * Allowed status moves. Anything absent is a 409 rather than a silent no-op —
 * an admin who thinks they reactivated a terminated member must be told they
 * did not.
 */
const STATUS_TRANSITIONS: Record<MemberStatus, MemberStatus[]> = {
  DRAFT: [MemberStatus.PENDING, MemberStatus.TERMINATED],
  PENDING: [MemberStatus.ACTIVE, MemberStatus.SUSPENDED, MemberStatus.TERMINATED],
  ACTIVE: [MemberStatus.SUSPENDED, MemberStatus.EXPIRED, MemberStatus.TERMINATED],
  SUSPENDED: [MemberStatus.ACTIVE, MemberStatus.EXPIRED, MemberStatus.TERMINATED],
  EXPIRED: [MemberStatus.ACTIVE, MemberStatus.TERMINATED],
  TERMINATED: [],
};

export const changeStatus = async (
  id: bigint,
  target: MemberStatus,
  reason: string,
  actor: Actor,
) => {
  const existing = await repo.findMemberById(prisma, id);
  if (!existing) throw notFound('member.notFound');

  if (!STATUS_TRANSITIONS[existing.status].includes(target)) {
    throw new AppError({
      errorType: ERROR_TYPES.CONFLICT,
      messageKey: 'member.invalidStatusTransition',
      code: 'INVALID_STATE_TRANSITION',
      details: { from: existing.status, to: target },
    });
  }

  return prisma.$transaction(async (tx) => {
    const updated = await repo.updateMember(tx, id, {
      status: target,
      // Directory listing is a consequence of status, not a separate switch an
      // admin has to remember: a suspended member disappears from the directory.
      ...(target === MemberStatus.ACTIVE && !existing.joined_on ? { joined_on: new Date() } : {}),
    });

    await repo.recordStatusChange(tx, {
      member_id: id,
      from_status: existing.status,
      to_status: target,
      reason,
      changed_by_admin_id: actor.id,
    });

    await writeAudit(tx, {
      ...adminAudit(actor),
      action: AUDIT_ACTIONS.MEMBER_STATUS_CHANGED,
      entityName: 'Members',
      entityId: id,
      before: { status: existing.status },
      after: { status: target, reason },
    });

    return updated;
  });
};

export const listStatusHistory = (id: bigint) => repo.listStatusHistory(prisma, id);

/**
 * Record an offline payment against an invoice, in full (`payment.record`).
 *
 * No online checkout exists yet — a member pays by bank transfer or similar
 * and staff confirm it landed. Marking the invoice PAID and, when it is the
 * membership's first invoice, moving the member PENDING → ACTIVE and its term
 * PENDING_PAYMENT → ACTIVE happen together: a paid invoice with a member still
 * pending is exactly the inconsistent state this guards against.
 */
export const recordInvoicePayment = async (memberId: bigint, invoiceId: bigint, actor: Actor) => {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, member_id: memberId, deletedAt: null },
  });
  if (!invoice) throw notFound('member.invoiceNotFound');

  if (invoice.status === InvoiceStatus.PAID) {
    throw conflict('member.invoiceAlreadyPaid');
  }
  if (invoice.status === InvoiceStatus.DRAFT || invoice.status === InvoiceStatus.CANCELLED) {
    throw conflict('member.invoiceNotPayable');
  }

  const member = await repo.findMemberById(prisma, memberId);
  if (!member) throw notFound('member.notFound');

  return prisma.$transaction(async (tx) => {
    const paidInvoice = await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        status: InvoiceStatus.PAID,
        amount_paid: invoice.total_amount,
        balance_due: new Prisma.Decimal(0),
      },
    });

    // Every term this invoice was raised for goes live together — a member
    // does not hold a mix of active and still-pending terms off one payment.
    await tx.membershipTerm.updateMany({
      where: { invoice_id: invoiceId, status: TermStatus.PENDING_PAYMENT },
      data: { status: TermStatus.ACTIVE },
    });

    let updatedMember = member;
    if (member.status === MemberStatus.PENDING) {
      updatedMember = await repo.updateMember(tx, memberId, {
        status: MemberStatus.ACTIVE,
        ...(member.joined_on ? {} : { joined_on: new Date() }),
      });

      await repo.recordStatusChange(tx, {
        member_id: memberId,
        from_status: member.status,
        to_status: MemberStatus.ACTIVE,
        reason: `Invoice ${invoice.invoice_number} paid`,
        changed_by_admin_id: actor.id,
      });
    }

    await writeAudit(tx, {
      ...adminAudit(actor),
      action: AUDIT_ACTIONS.INVOICE_PAID,
      entityName: 'Invoices',
      entityId: invoiceId,
      before: { status: invoice.status, amount_paid: invoice.amount_paid.toFixed(2) },
      after: { status: InvoiceStatus.PAID, amount_paid: invoice.total_amount.toFixed(2) },
    });

    return { invoice: paidInvoice, member: updatedMember };
  });
};
