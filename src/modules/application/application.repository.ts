import { Prisma } from '@prisma/client';
import type { ApplicationStatus } from '@prisma/client';
import type { Db } from '@db/prisma';
import { type DocumentSideValue, requiredSides } from '@modules/document/document.sides';
import { checklistFor } from '@modules/masters/masters.checklist';
import { OPEN_STATUSES } from '@modules/application/approval.engine';

/** Data access for applications and their approval requests. */

export const findOpenApplicationForUser = (db: Db, userId: bigint) =>
  db.membershipApplication.findFirst({
    where: { user_id: userId, status: { in: OPEN_STATUSES }, deletedAt: null },
  });

export const findApplicationById = (db: Db, id: bigint) =>
  db.membershipApplication.findFirst({ where: { id, deletedAt: null } });

/** Everything the review screen and the applicant's tracker both need. */
export const findApplicationDetail = (db: Db, id: bigint) =>
  db.membershipApplication.findFirst({
    where: { id, deletedAt: null },
    include: {
      category: { select: { id: true, code: true, name: true } },
      tier: { select: { id: true, code: true, name: true } },
      member: {
        select: {
          id: true,
          member_code: true,
          company_name: true,
          status: true,
          gstin_holder: true,
          company_category: true,
          landline: true,
          consent_accepted_at: true,
          company_type: { select: { id: true, code: true, name: true } },
          categories: {
            where: { category: { deletedAt: null } },
            select: { category: { select: { id: true, code: true, name: true } } },
            orderBy: { category: { display_order: 'asc' } },
          },
          addresses: {
            where: { deletedAt: null },
            orderBy: [{ is_primary: 'desc' }, { address_type: 'asc' }],
            select: {
              id: true,
              address_type: true,
              line1: true,
              line2: true,
              city: true,
              state: true,
              country: true,
              pincode: true,
              is_primary: true,
              // The master ids as well as the names they were captured under.
              // The names are what a reviewer reads; the ids are what a select
              // on the correction form has to be pre-set to (public.service
              // `fieldsOf`), and deriving one from the other by name lookup
              // would go wrong the first time two states share a city name.
              country_id: true,
              state_id: true,
              city_id: true,
            },
          },
        },
      },
      user: { select: { id: true, email: true, full_name: true, phone: true } },
      current_stage: {
        select: {
          id: true,
          name: true,
          sequence: true,
          is_final: true,
          approver_role: { select: { id: true, code: true, name: true } },
        },
      },
      documents: {
        where: { deletedAt: null },
        orderBy: [{ document_type_id: 'asc' }, { side: 'asc' }, { version: 'desc' }],
        include: {
          // Unfiltered on purpose — a file must resolve its type even if that
          // type was later retired. The name shown to staff and to the applicant
          // comes from here, never from the code.
          document_type: {
            select: { id: true, code: true, name: true, sides: true, is_required: true },
          },
          verified_by: { select: { id: true, full_name: true } },
        },
      },
      approval_requests: {
        orderBy: { createdAt: 'desc' },
        include: {
          workflow: { select: { id: true, code: true, name: true } },
          current_stage: { select: { id: true, name: true, sequence: true } },
          actions: {
            orderBy: { acted_at: 'desc' },
            include: {
              stage: { select: { id: true, name: true, sequence: true } },
              admin_user: { select: { id: true, full_name: true } },
            },
          },
        },
      },
    },
  });

export const createApplication = (db: Db, data: Prisma.MembershipApplicationUncheckedCreateInput) =>
  db.membershipApplication.create({ data });

export const updateApplication = (
  db: Db,
  id: bigint,
  data: Prisma.MembershipApplicationUpdateInput,
) => db.membershipApplication.update({ where: { id }, data });

export const listApplicationsForUser = (db: Db, userId: bigint) =>
  db.membershipApplication.findMany({
    where: { user_id: userId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    include: {
      category: { select: { name: true } },
      tier: { select: { name: true } },
      current_stage: { select: { name: true, sequence: true } },
    },
  });

export interface ApplicationQueueRow {
  id: bigint;
  application_number: string | null;
  company_name: string;
  status: ApplicationStatus;
  category_name: string;
  tier_name: string | null;
  stage_id: bigint | null;
  stage_name: string | null;
  stage_sequence: number | null;
  approver_role_code: string | null;
  sla_hours: number | null;
  submitted_at: Date | null;
  decided_at: Date | null;
  resubmission_count: number;
  document_count: bigint;
  pending_documents: bigint;
  createdAt: Date;
  updatedAt: Date;
  gst_number: string | null;
  pan_number: string;
  applicant_email: string;
  applicant_phone: string | null;
  company_type_name: string | null;
  /** Always the applicant — registration is self-serve, nobody files on their behalf. */
  created_by: string;
  /** Whoever recorded the most recent decision on this application, if any. */
  updated_by: string | null;
  /** Only the FINAL approval sets this — an intermediate stage clearing does not. */
  approved_by: string | null;
  /**
   * Who refused it, and only on a REJECT — the terminal refusal at the
   * resubmission cap. A RETURN is a correction round, not a rejection, and
   * naming a reviewer beside an application the applicant is still working on
   * would read as a decision that has not been made.
   */
  rejected_by: string | null;
  /** Primary address of the applying company. Free text; always populated. */
  city: string | null;
  state: string | null;
  total: bigint;
}

/**
 * The reviewer queue.
 *
 * `mine` narrows to stages the caller's own roles own — a reviewer wants their
 * work, not everyone's. Passing the role codes as an array and testing with
 * `= ANY` keeps it one parameterised statement; the sort column arrives
 * pre-allowlisted by zod.
 */
export const listApplications = (
  db: Db,
  params: {
    search?: string | undefined;
    statuses?: ApplicationStatus[] | undefined;
    stageIds?: bigint[] | undefined;
    categoryIds?: bigint[] | undefined;
    /** NULL disables the filter; an empty array means "no queues are mine". */
    myRoleCodes?: string[] | undefined;
    /** Verification tab: only applications carrying at least one PENDING document. */
    hasPendingDocuments?: boolean | undefined;
    /** Inclusive `YYYY-MM-DD` bounds on `submitted_at`. Either may stand alone. */
    submittedFrom?: string | undefined;
    submittedTo?: string | undefined;
    /**
     * Primary-address city / state, matched on the NAME rather than the master
     * id. The id columns are nullable and some rows predate them, but the text
     * columns are NOT NULL and always carry the same words the master holds —
     * so matching on the name is the one that cannot silently drop a row.
     */
    cities?: string[] | undefined;
    states?: string[] | undefined;
    sortBy: string;
    sortOrder: 'asc' | 'desc';
    limit: number;
    offset: number;
  },
): Promise<ApplicationQueueRow[]> => {
  const search = params.search ? `%${params.search}%` : null;
  const sortColumn = Prisma.raw(`a."${params.sortBy}"`);
  const sortDirection = Prisma.raw(params.sortOrder === 'asc' ? 'ASC' : 'DESC');
  const roleCodes = params.myRoleCodes ?? null;
  const statuses = params.statuses?.length ? params.statuses : null;
  const stageIds = params.stageIds?.length ? params.stageIds : null;
  const categoryIds = params.categoryIds?.length ? params.categoryIds : null;
  const pendingOnly = params.hasPendingDocuments === true;
  const submittedFrom = params.submittedFrom ?? null;
  const submittedTo = params.submittedTo ?? null;
  const cities = params.cities?.length ? params.cities : null;
  const states = params.states?.length ? params.states : null;

  return db.$queryRaw<ApplicationQueueRow[]>`
    SELECT a.id,
           a.application_number,
           a.company_name,
           a.status,
           c.name  AS category_name,
           t.name  AS tier_name,
           s.id    AS stage_id,
           s.name  AS stage_name,
           s.sequence AS stage_sequence,
           r.code  AS approver_role_code,
           s.sla_hours,
           a.submitted_at,
           a.decided_at,
           a.resubmission_count,
           (SELECT count(*) FROM "ApplicationDocuments" d
             WHERE d.application_id = a.id AND d."deletedAt" IS NULL) AS document_count,
           (SELECT count(*) FROM "ApplicationDocuments" d
             WHERE d.application_id = a.id AND d."deletedAt" IS NULL
               AND d.verification_status = 'PENDING')                AS pending_documents,
           a."createdAt",
           a."updatedAt",
           a.gst_number,
           a.pan_number,
           u.email AS applicant_email,
           u.phone AS applicant_phone,
           ct.name AS company_type_name,
           u.full_name AS created_by,
           (SELECT au.full_name
              FROM "ApprovalActions" aa
              JOIN "AdminUsers" au ON au.id = aa.admin_user_id
              JOIN "ApprovalRequests" ar ON ar.id = aa.approval_request_id
             WHERE ar.application_id = a.id
             ORDER BY aa.acted_at DESC
             LIMIT 1) AS updated_by,
           (SELECT au.full_name
              FROM "ApprovalActions" aa
              JOIN "AdminUsers" au ON au.id = aa.admin_user_id
              JOIN "ApprovalRequests" ar ON ar.id = aa.approval_request_id
             WHERE ar.application_id = a.id
               AND aa.action = 'APPROVE'
               AND aa.to_status = 'APPROVED'
             ORDER BY aa.acted_at DESC
             LIMIT 1) AS approved_by,
           (SELECT au.full_name
              FROM "ApprovalActions" aa
              JOIN "AdminUsers" au ON au.id = aa.admin_user_id
              JOIN "ApprovalRequests" ar ON ar.id = aa.approval_request_id
             WHERE ar.application_id = a.id
               AND aa.action = 'REJECT'
             ORDER BY aa.acted_at DESC
             LIMIT 1) AS rejected_by,
           addr.city,
           addr.state,
           -- The COMPANY's lifecycle state, not the application's: the status
           -- selected above is a.status. The member-company scope shows both,
           -- and they answer different questions -- whether the paperwork was
           -- approved, and whether the firm is a paid member today.
           mem.status AS member_status,
           mem.directory_visible,
           count(*) OVER () AS total
      FROM "MembershipApplications" a
      JOIN "MembershipCategories" c ON c.id = a.category_id
      JOIN "Users" u ON u.id = a.user_id
      JOIN "Members" mem ON mem.id = a.member_id
      LEFT JOIN "CompanyTypes" ct ON ct.id = mem.company_type_id
      LEFT JOIN "MembershipTiers" t ON t.id = a.tier_id
      LEFT JOIN "ApprovalStages"  s ON s.id = a.current_stage_id
      LEFT JOIN "Roles"           r ON r.id = s.approver_role_id
      -- LATERAL, not a plain join: a company may hold a registered, a factory
      -- and a correspondence address, and joining them all would multiply the
      -- row. One address per application, the primary one, chosen here.
      LEFT JOIN LATERAL (
        SELECT ma.city, ma.state
          FROM "MemberAddresses" ma
         WHERE ma.member_id = a.member_id AND ma."deletedAt" IS NULL
         ORDER BY ma.is_primary DESC, ma.id ASC
         LIMIT 1
      ) addr ON TRUE
     WHERE a."deletedAt" IS NULL
       -- A draft belongs to the applicant alone; it is not work for anyone yet.
       AND a.status <> 'DRAFT'
       -- Each filter takes a LIST. An empty selection is no filter at all, which
       -- is why the guard is on the array being null rather than on its length.
       AND (${statuses}::text[] IS NULL OR a.status::text = ANY(${statuses}::text[]))
       AND (${stageIds}::bigint[] IS NULL OR a.current_stage_id = ANY(${stageIds}::bigint[]))
       AND (${categoryIds}::bigint[] IS NULL OR a.category_id = ANY(${categoryIds}::bigint[]))
       AND (${roleCodes}::text[] IS NULL OR r.code = ANY(${roleCodes}::text[]))
       AND (${search}::text IS NULL
            OR a.company_name ILIKE ${search}
            OR a.application_number ILIKE ${search}
            OR a.gst_number ILIKE ${search})
       -- submitted_at is a timestamp, not a date, so the upper bound is "before
       -- the next day" rather than "<= that day" — otherwise everything after
       -- midnight on the last day of the window falls outside it.
       AND (${submittedFrom}::date IS NULL OR a.submitted_at >= ${submittedFrom}::date)
       AND (${submittedTo}::date IS NULL OR a.submitted_at < ${submittedTo}::date + 1)
       AND (${cities}::text[] IS NULL OR addr.city = ANY(${cities}::text[]))
       AND (${states}::text[] IS NULL OR addr.state = ANY(${states}::text[]))
       AND (${pendingOnly} IS FALSE OR EXISTS (
             SELECT 1 FROM "ApplicationDocuments" d
              WHERE d.application_id = a.id AND d."deletedAt" IS NULL
                AND d.verification_status = 'PENDING'))
     ORDER BY ${sortColumn} ${sortDirection} NULLS LAST, a.id DESC
     LIMIT ${params.limit} OFFSET ${params.offset}`;
};

/* --- workflow ------------------------------------------------------------- */

export const findActiveWorkflow = (
  db: Db,
  subjectType: 'MEMBERSHIP_APPLICATION' | 'PROFILE_CHANGE_REQUEST',
) =>
  db.approvalWorkflow.findFirst({
    where: { subject_type: subjectType, is_active: true },
    include: {
      stages: {
        orderBy: { sequence: 'asc' },
        include: { approver_role: { select: { id: true, code: true, name: true } } },
      },
    },
  });

export const findOpenRequestForApplication = (db: Db, applicationId: bigint) =>
  db.approvalRequest.findFirst({
    where: { application_id: applicationId, status: 'OPEN' },
    include: {
      current_stage: { include: { approver_role: { select: { code: true } } } },
      workflow: { include: { stages: { orderBy: { sequence: 'asc' } } } },
    },
  });

export const createApprovalRequest = (db: Db, data: Prisma.ApprovalRequestUncheckedCreateInput) =>
  db.approvalRequest.create({ data });

export const updateApprovalRequest = (
  db: Db,
  id: bigint,
  data: Prisma.ApprovalRequestUpdateInput,
) => db.approvalRequest.update({ where: { id }, data });

export const recordAction = (db: Db, data: Prisma.ApprovalActionUncheckedCreateInput) =>
  db.approvalAction.create({ data });

/* --- documents ------------------------------------------------------------ */

export const listApplicationDocuments = (db: Db, applicationId: bigint) =>
  db.applicationDocument.findMany({
    where: { application_id: applicationId, deletedAt: null },
    orderBy: [{ document_type_id: 'asc' }, { side: 'asc' }, { version: 'desc' }],
    include: {
      // Unfiltered on purpose — a file must resolve its type even if that type
      // was later retired.
      document_type: {
        select: { id: true, code: true, name: true, sides: true, is_required: true },
      },
    },
  });

/**
 * How many required KYC documents are not yet VERIFIED.
 *
 * The number the approve guard refuses on and the number its message names
 * (spec D-7). Counted over the LATEST version of each required type, because a
 * re-upload supersedes what came before: an application whose first GST scan was
 * rejected and whose second was accepted has nothing outstanding, and reading
 * every row would say otherwise.
 *
 * A type with no upload at all counts as outstanding. It is a stronger reason to
 * refuse an approval than a rejected one, not a weaker one.
 */
export const countUnverifiedRequiredDocuments = async (
  db: Db,
  applicationId: bigint,
): Promise<number> => {
  const required = (await checklistFor('APPLICATION')).filter((type) => type.is_required);

  const documents = await db.applicationDocument.findMany({
    where: { application_id: applicationId, deletedAt: null },
    orderBy: [{ document_type_id: 'asc' }, { side: 'asc' }, { version: 'desc' }],
    select: { document_type_id: true, side: true, verification_status: true },
  });

  const latest = new Map<string, string>();
  for (const document of documents) {
    const key = `${document.document_type_id}:${document.side}`;
    if (!latest.has(key)) latest.set(key, document.verification_status);
  }

  return required.reduce((count, type) => {
    // A COMBINED PDF stands for both faces, so its single verdict decides both.
    const combined = latest.get(`${type.id}:COMBINED`);
    if (combined) return count + (combined === 'VERIFIED' ? 0 : 1);

    const outstanding = requiredSides(type.sides).filter(
      (side: DocumentSideValue) => latest.get(`${type.id}:${side}`) !== 'VERIFIED',
    );

    return count + outstanding.length;
  }, 0);
};

/**
 * Flag one document the rejection named, in the rejection's own transaction.
 *
 * Scoped by `application_id` as well as by id, so an id from another application
 * — pasted, guessed, or left over in a stale browser tab — updates nothing
 * rather than reaching across the queue.
 *
 * `verification_status` is written here as well as by the per-document verify
 * endpoint on purpose. The panel's ✗ is a MARK (spec D-6), and the decision the
 * applicant is finally told about is this one — so this is the one that must be
 * on record, whatever the panel did or failed to do earlier.
 */
export const flagDocumentForReupload = (
  db: Db,
  applicationId: bigint,
  documentId: bigint,
  remarks: string,
  adminUserId: bigint,
  now: Date,
) =>
  db.applicationDocument.updateMany({
    where: { id: documentId, application_id: applicationId, deletedAt: null },
    data: {
      requires_reupload: true,
      verification_status: 'REJECTED',
      remarks,
      verified_by_admin_id: adminUserId,
      verified_at: now,
    },
  });

/**
 * The ✗ documents and their reasons, for the rejection email.
 *
 * Latest version per type, and only that one. A second rejection would otherwise
 * itemise the file that was flagged in round one and has since been replaced —
 * telling the applicant to re-upload something they already did, which is how a
 * correction cycle stops converging.
 */
export const listFlaggedDocuments = async (db: Db, applicationId: bigint) => {
  const documents = await db.applicationDocument.findMany({
    where: { application_id: applicationId, deletedAt: null },
    orderBy: [{ document_type_id: 'asc' }, { side: 'asc' }, { version: 'desc' }],
    select: {
      id: true,
      document_type_id: true,
      side: true,
      remarks: true,
      version: true,
      requires_reupload: true,
      document_type: { select: { code: true, name: true, sides: true } },
    },
  });

  // Newest file per (type, face). A rejected back and an accepted front are two
  // separate debts, and only the unsettled one is asked for again.
  const seen = new Set<string>();

  return documents
    .filter((document) => {
      const key = `${document.document_type_id}:${document.side}`;
      if (seen.has(key)) return false;
      seen.add(key);

      return document.requires_reupload;
    })
    .map(({ id, document_type, side, remarks }) => ({
      id,
      document_type: {
        code: document_type.code,
        name: document_type.name,
        sides: document_type.sides,
      },
      side,
      remarks,
    }));
};
