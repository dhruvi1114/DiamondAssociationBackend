import { Prisma } from '@prisma/client';
import type { MemberStatus } from '@prisma/client';
import type { Db } from '@db/prisma';
import { MEMBER_USER_STATUS } from '@modules/member/team.constants';

/**
 * Data access for the member record.
 *
 * The admin list is one raw statement with a windowed count and correlated
 * subqueries for the badges the screen shows. The alternative — fetch members,
 * then count documents per member — is the N+1 that turns a 500-member list into
 * 501 queries (ADR-005, database-indexes.md).
 */

/**
 * The company a signed-in member belongs to.
 *
 * Resolution goes through `MemberUsers` rather than `Members.primary_user_id`,
 * because a company can hold several logins — the owner plus the colleagues they
 * invited — and every one of them must land on the same company record.
 *
 * Only ACTIVE rows resolve. An INVITED login has not set a password yet and a
 * DEACTIVATED one has been switched off by its owner; neither may act for the
 * firm, and filtering here means no caller can forget to check.
 */
export const findMemberByUserId = (db: Db, userId: bigint) =>
  db.member.findFirst({
    where: {
      deletedAt: null,
      team_users: { some: { user_id: userId, status: MEMBER_USER_STATUS.ACTIVE } },
    },
  });

export const findMemberById = (db: Db, id: bigint) =>
  db.member.findFirst({ where: { id, deletedAt: null } });

export const createMember = (db: Db, data: Prisma.MemberUncheckedCreateInput) =>
  db.member.create({ data });

export const updateMember = (db: Db, id: bigint, data: Prisma.MemberUpdateInput) =>
  db.member.update({ where: { id }, data });

/** Full profile for the member's own screens and the admin detail view. */
export const findMemberDetail = (db: Db, id: bigint) =>
  db.member.findFirst({
    where: { id, deletedAt: null },
    include: {
      categories: {
        where: { category: { deletedAt: null } },
        select: { category: { select: { id: true, code: true, name: true } } },
        orderBy: { category: { display_order: 'asc' } },
      },
      company_type: { select: { id: true, code: true, name: true } },
      primary_user: {
        select: { id: true, email: true, full_name: true, phone: true, status: true },
      },
      contacts: { where: { deletedAt: null }, orderBy: [{ is_primary: 'desc' }, { name: 'asc' }] },
      addresses: {
        where: { deletedAt: null },
        orderBy: [{ is_primary: 'desc' }, { address_type: 'asc' }],
      },
      invoices: { where: { deletedAt: null }, orderBy: { issue_date: 'desc' } },
    },
  });

export interface MemberListRow {
  id: bigint;
  member_code: string | null;
  company_name: string;
  legal_name: string | null;
  status: MemberStatus;
  category_name: string | null;
  tier_name: string | null;
  contact_email: string | null;
  city: string | null;
  /** Primary address state. Free text; NOT NULL on the row it comes from. */
  state: string | null;
  document_count: bigint;
  pending_documents: bigint;
  createdAt: Date;
  updatedAt: Date;
  gst_number: string | null;
  pan_number: string | null;
  mobile: string | null;
  company_type_name: string | null;
  /** Always the applicant — a member row is created at signup, ADR-016. */
  created_by: string;
  /** Whoever recorded the most recent status change, if any. NULL when the
   *  platform made the change itself (payment received, term expired). */
  updated_by: string | null;
  /** The PENDING → ACTIVE transition specifically. Often NULL — activation
   *  usually happens automatically when payment is recorded, not by an admin. */
  approved_by: string | null;
  /**
   * Who terminated the membership, when a person did.
   *
   * TERMINATED is the only refusal a MEMBER can carry — a member row in this
   * list was approved to get here, so there is no rejection to report. An
   * application's rejection lives on the application, not here.
   */
  rejected_by: string | null;
  total: bigint;
}

/**
 * Admin member list. Search covers company name, legal name, member code, GST and
 * the owning login's email — the five things staff actually paste into a search
 * box. The sort column arrives pre-allowlisted by zod, so interpolating it here
 * is safe; the values remain parameterised.
 *
 * `DRAFT` and `PENDING` rows are excluded unconditionally, not behind an
 * optional filter — this list's whole meaning is "companies that are members",
 * and a company becomes one only once it has paid and been activated. Before
 * that it is still an application, and lives in the application queue instead.
 * `member_code IS NOT NULL` is the second half of the same guard: a code is
 * assigned at approval and never cleared, so its absence means this row was
 * never activated even if its status is something else — which is possible
 * because `member.service.ts`'s status-transition table currently allows a
 * `DRAFT` row to move straight to `TERMINATED`.
 */
export const listMembers = (
  db: Db,
  params: {
    search?: string | undefined;
    statuses?: MemberStatus[] | undefined;
    categoryIds?: bigint[] | undefined;
    tierId?: bigint | undefined;
    /**
     * Primary-address city / state, matched on the NAME. The master-id columns
     * on `MemberAddresses` are nullable and older rows leave them empty; the
     * text columns never are, so a name match cannot silently drop a member.
     */
    cities?: string[] | undefined;
    states?: string[] | undefined;
    sortBy: string;
    sortOrder: 'asc' | 'desc';
    limit: number;
    offset: number;
  },
): Promise<MemberListRow[]> => {
  const search = params.search ? `%${params.search}%` : null;
  const statuses = params.statuses?.length ? params.statuses : null;
  const categoryIds = params.categoryIds?.length ? params.categoryIds : null;
  const cities = params.cities?.length ? params.cities : null;
  const states = params.states?.length ? params.states : null;
  const sortColumn = Prisma.raw(`m."${params.sortBy}"`);
  const sortDirection = Prisma.raw(params.sortOrder === 'asc' ? 'ASC' : 'DESC');

  return db.$queryRaw<MemberListRow[]>`
    SELECT m.id,
           m.member_code,
           m.company_name,
           m.legal_name,
           m.status,
           (SELECT string_agg(c.name, ', ' ORDER BY c.display_order)
              FROM "MemberCategories" mc
              JOIN "MembershipCategories" c ON c.id = mc.category_id
             WHERE mc.member_id = m.id AND c."deletedAt" IS NULL) AS category_name,
           NULL::text AS tier_name,
           u.email AS contact_email,
           addr.city,
           addr.state,
           (SELECT count(*) FROM "MemberDocuments" d
             WHERE d.member_id = m.id AND d."deletedAt" IS NULL) AS document_count,
           (SELECT count(*) FROM "MemberDocuments" d
             WHERE d.member_id = m.id AND d."deletedAt" IS NULL
               AND d.verification_status = 'PENDING') AS pending_documents,
           m."createdAt",
           m."updatedAt",
           m.gst_number,
           m.pan_number,
           u.phone AS mobile,
           ct.name AS company_type_name,
           u.full_name AS created_by,
           (SELECT au.full_name
              FROM "MemberStatusHistory" h
              LEFT JOIN "AdminUsers" au ON au.id = h.changed_by_admin_id
             WHERE h.member_id = m.id
             ORDER BY h."createdAt" DESC
             LIMIT 1) AS updated_by,
           (SELECT au.full_name
              FROM "MemberStatusHistory" h
              LEFT JOIN "AdminUsers" au ON au.id = h.changed_by_admin_id
             WHERE h.member_id = m.id
               AND h.to_status = 'ACTIVE'
             ORDER BY h."createdAt" DESC
             LIMIT 1) AS approved_by,
           (SELECT au.full_name
              FROM "MemberStatusHistory" h
              JOIN "AdminUsers" au ON au.id = h.changed_by_admin_id
             WHERE h.member_id = m.id
               AND h.to_status = 'TERMINATED'
             ORDER BY h."createdAt" DESC
             LIMIT 1) AS rejected_by,
           count(*) OVER () AS total
      FROM "Members" m
      JOIN "Users" u ON u.id = m.primary_user_id
      LEFT JOIN "CompanyTypes" ct ON ct.id = m.company_type_id
      -- LATERAL so city and state come off the SAME address row. As two
      -- independent subqueries they could disagree — a member holding a
      -- registered and a factory address would have shown one's city beside
      -- the other's state the moment the ordering tied.
      LEFT JOIN LATERAL (
        SELECT a.city, a.state
          FROM "MemberAddresses" a
         WHERE a.member_id = m.id AND a."deletedAt" IS NULL
         ORDER BY a.is_primary DESC, a.id ASC
         LIMIT 1
      ) addr ON TRUE
     WHERE m."deletedAt" IS NULL
       -- Not a member yet — see the doc comment above.
       AND m.status NOT IN ('DRAFT', 'PENDING')
       AND m.member_code IS NOT NULL
       -- Lists, not single values; an empty selection is no filter at all.
       AND (${statuses}::text[] IS NULL OR m.status::text = ANY(${statuses}::text[]))
       AND (${categoryIds}::bigint[] IS NULL
            OR EXISTS (SELECT 1 FROM "MemberCategories" mc2
                        WHERE mc2.member_id = m.id
                          AND mc2.category_id = ANY(${categoryIds}::bigint[])))
       AND (${cities}::text[] IS NULL OR addr.city = ANY(${cities}::text[]))
       AND (${states}::text[] IS NULL OR addr.state = ANY(${states}::text[]))
       AND (${search}::text IS NULL
            OR m.company_name ILIKE ${search}
            OR m.legal_name ILIKE ${search}
            OR m.member_code ILIKE ${search}
            OR m.gst_number ILIKE ${search}
            OR u.email ILIKE ${search})
     ORDER BY ${sortColumn} ${sortDirection}, m.id DESC
     LIMIT ${params.limit} OFFSET ${params.offset}`;
};

/* --- invoices (M5) ----------------------------------------------------------
 *
 * Org-wide, unlike `findMemberDetail`'s embedded `invoices` (one member at a
 * time). Same windowed-count shape as `listMembers` for the same reason: one
 * statement, no read-then-count round trip.
 */

export interface InvoiceListRow {
  id: bigint;
  invoice_number: string;
  invoice_type: string;
  status: string;
  issue_date: Date;
  due_date: Date;
  subtotal: Prisma.Decimal;
  tax_amount: Prisma.Decimal;
  total_amount: Prisma.Decimal;
  amount_paid: Prisma.Decimal;
  balance_due: Prisma.Decimal;
  currency: string;
  member_id: bigint;
  company_name: string;
  member_code: string | null;
  /** When the invoice was actually settled. NULL until a receipt exists. */
  paid_at: Date | null;
  total: bigint;
}

export const listInvoices = (
  db: Db,
  params: {
    search?: string | undefined;
    statuses?: string[] | undefined;
    /** Inclusive `YYYY-MM-DD` bounds on `issue_date`. Either may stand alone. */
    issuedFrom?: string | undefined;
    issuedTo?: string | undefined;
    sortBy: string;
    sortOrder: 'asc' | 'desc';
    limit: number;
    offset: number;
  },
): Promise<InvoiceListRow[]> => {
  const search = params.search ? `%${params.search}%` : null;
  const statuses = params.statuses?.length ? params.statuses : null;
  const issuedFrom = params.issuedFrom ?? null;
  const issuedTo = params.issuedTo ?? null;
  const sortColumn = Prisma.raw(`i."${params.sortBy}"`);
  const sortDirection = Prisma.raw(params.sortOrder === 'asc' ? 'ASC' : 'DESC');

  return db.$queryRaw<InvoiceListRow[]>`
    SELECT i.id,
           i.invoice_number,
           i.invoice_type,
           i.status,
           i.issue_date,
           i.due_date,
           i.subtotal,
           i.tax_amount,
           i.total_amount,
           i.amount_paid,
           i.balance_due,
           i.currency,
           m.id AS member_id,
           m.company_name,
           m.member_code,
           r.paid_at,
           count(*) OVER () AS total
      FROM "Invoices" i
      JOIN "Members" m ON m.id = i.member_id
      -- LEFT, not INNER: an unpaid invoice has no receipt and must still list.
      -- One receipt per invoice is enforced by a unique constraint on
      -- Receipts.invoice_id, so this can never multiply the rows.
      LEFT JOIN "Receipts" r ON r.invoice_id = i.id
     WHERE i."deletedAt" IS NULL
       AND (${statuses}::text[] IS NULL OR i.status::text = ANY(${statuses}::text[]))
       AND (${search}::text IS NULL
            OR i.invoice_number ILIKE ${search}
            OR m.company_name ILIKE ${search}
            OR m.member_code ILIKE ${search})
       -- Compared as dates, not timestamps: issue_date IS a date column, so the
       -- upper bound includes the whole of the day the user picked.
       AND (${issuedFrom}::date IS NULL OR i.issue_date >= ${issuedFrom}::date)
       AND (${issuedTo}::date IS NULL OR i.issue_date <= ${issuedTo}::date)
     ORDER BY ${sortColumn} ${sortDirection}, i.id DESC
     LIMIT ${params.limit} OFFSET ${params.offset}`;
};

/* --- contacts -------------------------------------------------------------- */

export const listContacts = (db: Db, memberId: bigint) =>
  db.memberContact.findMany({
    where: { member_id: memberId, deletedAt: null },
    orderBy: [{ is_primary: 'desc' }, { name: 'asc' }],
  });

export const findContact = (db: Db, memberId: bigint, id: bigint) =>
  db.memberContact.findFirst({ where: { id, member_id: memberId, deletedAt: null } });

export const createContact = (db: Db, data: Prisma.MemberContactUncheckedCreateInput) =>
  db.memberContact.create({ data });

export const updateContact = (db: Db, id: bigint, data: Prisma.MemberContactUpdateInput) =>
  db.memberContact.update({ where: { id }, data });

/** Demote the current primary so the partial unique index cannot be violated. */
export const clearPrimaryContacts = (db: Db, memberId: bigint, exceptId?: bigint) =>
  db.memberContact.updateMany({
    where: {
      member_id: memberId,
      deletedAt: null,
      is_primary: true,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    data: { is_primary: false },
  });

export const countContacts = (db: Db, memberId: bigint) =>
  db.memberContact.count({ where: { member_id: memberId, deletedAt: null } });

/* --- addresses ------------------------------------------------------------- */

export const listAddresses = (db: Db, memberId: bigint) =>
  db.memberAddress.findMany({
    where: { member_id: memberId, deletedAt: null },
    orderBy: [{ is_primary: 'desc' }, { address_type: 'asc' }],
  });

export const findAddress = (db: Db, memberId: bigint, id: bigint) =>
  db.memberAddress.findFirst({ where: { id, member_id: memberId, deletedAt: null } });

export const createAddress = (db: Db, data: Prisma.MemberAddressUncheckedCreateInput) =>
  db.memberAddress.create({ data });

export const updateAddress = (db: Db, id: bigint, data: Prisma.MemberAddressUpdateInput) =>
  db.memberAddress.update({ where: { id }, data });

export const clearPrimaryAddresses = (db: Db, memberId: bigint, exceptId?: bigint) =>
  db.memberAddress.updateMany({
    where: {
      member_id: memberId,
      deletedAt: null,
      is_primary: true,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    data: { is_primary: false },
  });

/* --- change requests ------------------------------------------------------- */

export const findOpenChangeRequest = (db: Db, memberId: bigint) =>
  db.memberProfileChangeRequest.findFirst({
    where: { member_id: memberId, status: 'PENDING' },
  });

export const createChangeRequest = (
  db: Db,
  data: Prisma.MemberProfileChangeRequestUncheckedCreateInput,
) => db.memberProfileChangeRequest.create({ data });

export const listChangeRequests = (db: Db, memberId: bigint) =>
  db.memberProfileChangeRequest.findMany({
    where: { member_id: memberId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

/* --- status history -------------------------------------------------------- */

export const recordStatusChange = (db: Db, data: Prisma.MemberStatusHistoryUncheckedCreateInput) =>
  db.memberStatusHistory.create({ data });

export const listStatusHistory = (db: Db, memberId: bigint) =>
  db.memberStatusHistory.findMany({
    where: { member_id: memberId },
    orderBy: { createdAt: 'desc' },
    include: { changed_by: { select: { id: true, full_name: true } } },
    take: 100,
  });

/* -------------------------------------------------------------------------- */
/* Member categories — the registration form's "Business Nature" claims       */
/* -------------------------------------------------------------------------- */

/** Replace a member's category claims wholesale. Takes `Db` for use inside transactions. */
export const setMemberCategories = async (
  db: Db,
  memberId: bigint,
  categoryIds: readonly bigint[],
): Promise<void> => {
  await db.memberCategory.deleteMany({ where: { member_id: memberId } });

  if (categoryIds.length === 0) return;

  await db.memberCategory.createMany({
    data: categoryIds.map((category_id) => ({ member_id: memberId, category_id })),
    skipDuplicates: true,
  });
};

/** The categories a member claims, in the master's display order. */
export const listMemberCategories = (db: Db, memberId: bigint) =>
  db.memberCategory.findMany({
    where: { member_id: memberId, category: { deletedAt: null } },
    select: {
      category: { select: { id: true, code: true, name: true, display_order: true } },
    },
    orderBy: { category: { display_order: 'asc' } },
  });
