import {
  AddressType,
  ApplicationStatus,
  ApprovalRequestStatus,
  ApprovalSubjectType,
  DocumentVerificationStatus,
  UserStatus,
  type MembershipApplication,
  type Prisma,
} from '@prisma/client';
import { ACTOR_TYPES, AUDIT_ACTIONS } from '@constant/audit.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { prisma, type Db } from '@db/prisma';
import { writeAudit } from '@helpers/audit';
import { getNumericSetting, SETTING_KEYS } from '@helpers/settings';
import { storage } from '@helpers/storage';
import { logger } from '@logger/logger';
import { queueNotifications } from '@notifications/outbox';
import {
  describeSide,
  type DocumentSideValue,
  requiredSides,
} from '@modules/document/document.sides';
import { checklistFor } from '@modules/masters/masters.checklist';
import * as authRepo from '@modules/auth/auth.repository';
import * as engine from '@modules/application/approval.engine';
import * as repo from '@modules/application/application.repository';
import {
  issueApplicationAccessToken,
  resolveApplicationAccessToken,
  resubmitLinkFor,
} from '@modules/application/application.tokens';
import {
  CORRECTABLE_FIELDS,
  type CorrectApplicationInput,
  type CorrectableField,
  type CorrectableFieldValues,
  type ReopenApplicationInput,
  type ResetResubmissionsInput,
} from '@modules/application/public.types';
import * as memberRepo from '@modules/member/member.repository';
import * as documentService from '@modules/document/document.service';
import { AppError } from '@utils/appError';

/**
 * The login-free correction surface (spec §6 item 6, D-9).
 *
 * Everything in this file runs for a caller with no session, no account and no
 * password, holding nothing but a URL. Three rules follow from that and are
 * worth stating once here rather than repeating at every function:
 *
 *  1. **The token is the only authority.** No id is ever read from the request
 *     to decide *what* is being acted on — the token resolves to exactly one
 *     `application_id` and every query is scoped by it. There is no id to tamper
 *     with, so there is no horizontal-access surface to defend.
 *  2. **Every failure looks the same.** A revoked link, an unknown link and a
 *     link to a decided application all answer `application.linkInvalid` with a
 *     404. Distinguishing them would tell an unauthenticated caller which
 *     guesses were close (security.md §2).
 *  3. **Fields are open, documents are gated.** Every form field on the snapshot
 *     is editable while the application is awaiting a correction (D-16) — the
 *     reviewer's note says what is wrong, and no per-field flag exists to read.
 *     Documents are the exception and stay gated by `requires_reupload`, because
 *     a `VERIFIED` file must not be pushed back to `PENDING` by a re-upload
 *     nobody asked for (D-12).
 *
 * What "open" does NOT mean is "unchecked". A corrected GSTIN is validated
 * against every live member and every other live application before it is
 * accepted (D-17) — see `assertIdentityAvailable`.
 */

export interface PublicContext {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

const linkInvalid = (): AppError =>
  new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'application.linkInvalid' });

const conflict = (messageKey: string, details?: unknown): AppError =>
  new AppError({ errorType: ERROR_TYPES.CONFLICT, messageKey, details });

/**
 * The resubmission cap.
 *
 * Falls back to 3, the seeded default (spec D-4/OQ-1), rather than to the `0`
 * that means unlimited. If the settings row is missing, "three attempts" is a
 * wrong answer an admin can see and correct; "unlimited" is a wrong answer that
 * silently removes the limit the association asked for.
 */
const resubmissionLimit = (): Promise<number> =>
  getNumericSetting(SETTING_KEYS.MAX_RESUBMISSIONS, 3);

/* -------------------------------------------------------------------------- */
/* Reading the application behind a link                                       */
/* -------------------------------------------------------------------------- */

type ApplicationDetail = NonNullable<Awaited<ReturnType<typeof repo.findApplicationDetail>>>;

/**
 * The reviewer's overall note — the sentence the applicant is owed first.
 *
 * Read from the approval history rather than stored on the application, because
 * the history is the record that cannot be overwritten by the next round. The
 * newest REJECT or RETURN with words on it wins; an approval's remarks are not
 * an instruction to the applicant and are deliberately not shown.
 */
const reviewerNoteOf = (application: ApplicationDetail): string | null => {
  const actions = application.approval_requests
    .flatMap((request) => request.actions)
    .filter((action) => action.action === 'REJECT' || action.action === 'RETURN')
    .sort((a, b) => (b.acted_at?.getTime() ?? 0) - (a.acted_at?.getTime() ?? 0));

  const note = actions.find((action) => (action.remarks ?? '').trim() !== '');

  return note?.remarks?.trim() ?? null;
};

/**
 * The newest live row per document type.
 *
 * A re-upload adds a version rather than replacing one (`ApplicationDocuments`
 * is append-only evidence, ADR-006), so "the GST certificate" means the highest
 * version of that type — the older ones are the audit trail of the correction,
 * not files the applicant still owes.
 */
const currentDocuments = async (application: ApplicationDetail) => {
  const checklist = await checklistFor('APPLICATION');

  // Newest file per (type, face). A two-sided document has a newest front AND a
  // newest back, and collapsing them would report half a document as whole.
  const newest = new Map<string, ApplicationDetail['documents'][number]>();

  for (const document of application.documents) {
    const key = `${document.document_type_id}:${document.side}`;
    const existing = newest.get(key);
    if (!existing || document.version > existing.version) {
      newest.set(key, document);
    }
  }

  return checklist.flatMap((type) =>
    requiredSides(type.sides).map((side) => ({
      code: type.code,
      side,
      // A COMBINED PDF stands in for both faces.
      label: describeSide(type.name, side),
      document: newest.get(`${type.id}:${side}`) ?? newest.get(`${type.id}:COMBINED`) ?? null,
    })),
  );
};

export interface PublicDocumentView {
  document_type: string;
  /** Which face of the document this row is asking for. */
  side: DocumentSideValue;
  /** "Aadhaar Card (back)" — composed from the master, never from a code. */
  label: string;
  verification_status: DocumentVerificationStatus | null;
  /** The reviewer's own words about THIS file. Quoted, never paraphrased. */
  remarks: string | null;
  requires_reupload: boolean;
  original_name: string | null;
  uploaded_at: string | null;
}

export interface PublicApplicationView {
  application_number: string | null;
  company_name: string;
  status: ApplicationStatus;
  submitted_at: string | null;
  /** TRUE only while the application is genuinely waiting on the applicant. */
  correctable: boolean;
  attempts: {
    used: number;
    /** NULL when the association has set no limit. */
    limit: number | null;
    remaining: number | null;
  };
  reviewer_note: string | null;
  /**
   * The whole registration form, flattened and pre-filled.
   *
   * Flat and keyed exactly as the form posts it, so the client binds one object
   * to one form rather than reassembling it from `member`, `address` and `user`
   * sub-objects that only this endpoint would ever produce. `email` is in here
   * and is not in `editable_fields`; everything else in `editable_fields` is in
   * here (see `CorrectableFieldValues`).
   */
  fields: CorrectableFieldValues;
  /**
   * Which of `fields` may be written right now.
   *
   * Since D-16 this is all of them while `correctable` is true, and empty
   * otherwise. It stays a LIST rather than becoming a boolean so the client
   * never has to hold its own copy of the field names: whatever is in here is
   * what the PATCH will accept, and a future narrowing is a server change alone.
   */
  editable_fields: CorrectableField[];
  documents: PublicDocumentView[];
  /** Still owed. Empty means the applicant may resubmit. */
  outstanding_documents: Array<{ document_type: string; side: DocumentSideValue; label: string }>;
  can_resubmit: boolean;
}

/**
 * The address the registration form filled in.
 *
 * `REGISTERED` by name rather than "the primary one": registration writes
 * exactly one address and marks it primary, but a member who later adds a
 * factory address could make the primary flag point somewhere else, and a
 * correction form must not then offer to edit the factory. Falls back to the
 * first live address only so a member with an odd address_type still sees
 * something to correct rather than an empty form.
 */
const registeredAddressOf = (application: ApplicationDetail) =>
  application.member.addresses.find((row) => row.address_type === AddressType.REGISTERED) ??
  application.member.addresses[0] ??
  null;

/** BigInt ids cross the wire as strings — see `CorrectableFieldValues`. */
const idString = (value: bigint | null | undefined): string | null =>
  value === null || value === undefined ? null : value.toString();

/**
 * One flat form out of four tables.
 *
 * The registration form posts one object; the transaction behind it spreads that
 * object over `MembershipApplications` (the frozen snapshot),
 * `Members` (company facts), `MemberAddresses` (the registered office) and
 * `Users` (the mobile). Handing the correction page those four shapes and
 * asking it to reassemble the form would put the mapping in a client that
 * cannot be tested against the schema — so the flattening lives here, next to
 * the code that writes them back, and the two are read together or not at all.
 *
 * Which table wins where a column exists twice:
 *
 *  - `company_name`, `gst_number`, `pan_number` are read from the **snapshot**,
 *    because that is what the correction writes and what `activation.service.ts`
 *    copies onto the member at approval. The `Members` copy is what registration
 *    left behind and is deliberately stale until somebody approves the change.
 *  - `gstin_holder`, `company_category`, `landline`, `company_type_id` and the
 *    categories exist only on `Members`; the address only on `MemberAddresses`;
 *    the mobile only on `Users`. There is no snapshot column to prefer.
 */
const fieldsOf = (application: ApplicationDetail): CorrectableFieldValues => {
  const member = application.member;
  const address = registeredAddressOf(application);

  return {
    email: application.user.email,
    pan_number: application.pan_number,
    gstin_holder: member.gstin_holder,
    gst_number: application.gst_number,
    company_category: member.company_category,
    company_name: application.company_name,
    company_type_id: idString(member.company_type?.id),
    address_line1: address?.line1 ?? null,
    address_line2: address?.line2 ?? null,
    pincode: address?.pincode ?? null,
    country_id: idString(address?.country_id),
    state_id: idString(address?.state_id),
    city_id: idString(address?.city_id),
    landline: member.landline,
    mobile: application.user.phone,
    category_ids: member.categories.map((row) => row.category.id.toString()),
    legal_name: application.legal_name,
    business_type: application.business_type,
    trade_license_no: application.trade_license_no,
    website: application.website,
    about: application.about,
  };
};

const buildView = async (application: ApplicationDetail): Promise<PublicApplicationView> => {
  const limit = await resubmissionLimit();
  const rows = await currentDocuments(application);
  const flagged = rows
    .filter((row) => row.document?.requires_reupload === true)
    .map((row) => ({ document_type: row.code, side: row.side, label: row.label }));

  const correctable = application.status === ApplicationStatus.RETURNED_FOR_CORRECTION;

  return {
    application_number: application.application_number,
    company_name: application.company_name,
    status: application.status,
    submitted_at: application.submitted_at?.toISOString() ?? null,
    correctable,
    attempts: {
      used: application.resubmission_count,
      limit: limit > 0 ? limit : null,
      remaining: limit > 0 ? Math.max(limit - application.resubmission_count, 0) : null,
    },
    reviewer_note: reviewerNoteOf(application),
    fields: fieldsOf(application),
    // Everything, or nothing (D-16). Nothing once the application has left the
    // applicant's hands — the same link is used to TRACK a submission (spec §5,
    // "track or update it here"), and a form that accepts edits nobody will read
    // is a lie.
    editable_fields: correctable ? [...CORRECTABLE_FIELDS] : [],
    documents: rows.map(({ code, side, label, document }) => ({
      document_type: code,
      side,
      label,
      verification_status: document?.verification_status ?? null,
      remarks: document?.remarks ?? null,
      requires_reupload: document?.requires_reupload ?? false,
      original_name: document?.original_name ?? null,
      uploaded_at: document?.createdAt?.toISOString() ?? null,
    })),
    outstanding_documents: correctable ? flagged : [],
    can_resubmit: correctable && flagged.length === 0,
  };
};

/**
 * Resolve a link to its application, or refuse.
 *
 * `assertCorrectable` is the difference between reading and writing: the link
 * keeps working while the application is under review so the applicant can watch
 * it move, but only `RETURNED_FOR_CORRECTION` accepts a change.
 */
const loadForToken = async (
  db: Db,
  token: string,
  options: { assertCorrectable: boolean },
): Promise<ApplicationDetail> => {
  const resolved = await resolveApplicationAccessToken(db, token);
  if (!resolved) throw linkInvalid();

  const application = await repo.findApplicationDetail(db, resolved.applicationId);
  // A live token pointing at a soft-deleted application is not an error worth
  // describing to an anonymous caller; it is the same dead link as any other.
  if (!application) throw linkInvalid();

  if (options.assertCorrectable && application.status !== ApplicationStatus.RETURNED_FOR_CORRECTION)
    throw conflict('application.notAwaitingCorrection', { status: application.status });

  return application;
};

/**
 * Re-check inside the transaction, holding the row.
 *
 * `loadForToken` reads before the transaction opens, which leaves a window: a
 * reviewer can approve — or the cap can close — an application between the
 * applicant's page loading and their upload committing. Without this, a
 * correction could land on an application that was decided a second earlier, and
 * a replaced document would change the evidence behind a decision already taken.
 *
 * `FOR UPDATE` on the application row is what actually closes it rather than
 * merely narrowing it. Every decision path updates this same row, so a
 * concurrent approval either commits before this lock is taken — and the status
 * check below then fails, correctly — or waits behind it until this transaction
 * finishes. The token is re-resolved too, because approval and final rejection
 * revoke it in that same transaction.
 */
const assertStillCorrectable = async (
  tx: Db,
  token: string,
  applicationId: bigint,
): Promise<void> => {
  await tx.$queryRaw`SELECT id FROM "MembershipApplications" WHERE id = ${applicationId} FOR UPDATE`;

  const resolved = await resolveApplicationAccessToken(tx, token);
  if (!resolved || resolved.applicationId !== applicationId) throw linkInvalid();

  const fresh = await tx.membershipApplication.findFirst({
    where: { id: applicationId, deletedAt: null },
    select: { status: true },
  });

  if (fresh?.status !== ApplicationStatus.RETURNED_FOR_CORRECTION) {
    throw conflict('application.notAwaitingCorrection', { status: fresh?.status ?? null });
  }
};

export const getByToken = async (token: string): Promise<PublicApplicationView> =>
  buildView(await loadForToken(prisma, token, { assertCorrectable: false }));

/* -------------------------------------------------------------------------- */
/* Identity collisions, caught while the applicant is still on the page (D-17) */
/* -------------------------------------------------------------------------- */

/**
 * Is this mobile number free for this applicant to use?
 *
 * `Users_phone_active_key` is a partial unique index over live rows, so a
 * corrected mobile that another account already holds is a `P2002` inside the
 * correction transaction — a 500 with a Prisma constraint name in it, on a page
 * an applicant is looking at. Checking first turns that into a sentence under
 * the field.
 *
 * Registration handles the same collision differently on purpose: it drops the
 * phone and creates the account without one (`register.service.ts`), because
 * refusing there would let a stranger discover which mobile numbers are
 * registered by watching which addresses fail. Nothing here is discoverable
 * that way — the caller already holds a link to one specific application — and
 * silently discarding a correction the applicant just made would be the worse
 * failure of the two: they would be told it saved, and it would not have.
 */
const assertMobileAvailable = async (
  db: Db,
  mobile: string | null,
  userId: bigint,
): Promise<void> => {
  const phone = mobile?.trim();
  if (!phone) return;

  const taken = await db.user.findFirst({
    where: { phone, deletedAt: null, id: { not: userId } },
    select: { id: true },
  });

  if (taken) {
    throw new AppError({
      errorType: ERROR_TYPES.CONFLICT,
      messageKey: 'application.mobileAlreadyRegistered',
      details: { fields: { mobile: 'application.mobileAlreadyRegistered' } },
    });
  }
};

/**
 * Is this GSTIN free for this applicant to use?
 *
 * The failure this prevents is specific and expensive. `activation.service.ts`
 * copies the approved snapshot onto the `Members` row, and
 * `Members_gst_number_live_key` — a partial unique index over live members — is
 * the only thing standing behind that copy. A correction that duplicates another
 * member's GSTIN therefore passes every check the applicant can see, sits in the
 * queue for as long as the committee takes, and then explodes inside the
 * approval transaction, in front of a reviewer who did not cause it and cannot
 * fix it. Checking here moves the refusal to the one moment somebody can act on
 * it: while the applicant is looking at the field they just typed.
 *
 * Two collisions are checked, because the index only knows about one of them:
 *
 *  - **Live members.** Exactly what the index enforces, minus the applicant's
 *    own row. That exclusion is essential rather than tidy: registration writes
 *    the GSTIN onto `Members` as well as onto the application snapshot, so an
 *    applicant re-typing their own unchanged number would otherwise be told it
 *    belongs to somebody else.
 *  - **Other live applications.** No index covers this — `MembershipApplications`
 *    has no unique constraint on `gst_number` — so two applications can carry the
 *    same GSTIN happily right up until the second one is approved. First past the
 *    post is the rule either way; this just makes the loser find out now.
 *
 * The mobile is checked the same way, one function up, for the same reason: an
 * index exists, so the collision is going to be found either here or inside a
 * transaction that cannot explain itself.
 *
 * **Documented ambiguity — PAN.** The spec's D-17 line names "a corrected GSTIN
 * or PAN", but the data model deliberately disagrees: `Members.pan_number` is
 * annotated *"Not unique — a group may share one across entities"*, no index
 * enforces it, and `register.service.ts` accepts a duplicate PAN without
 * comment. Refusing one here would make correcting an application stricter than
 * submitting one, so a group entity could register with a shared PAN and then be
 * blocked from fixing a typo in its own address. That is a business rule nobody
 * has stated, so it is not implemented — if the association does want PAN to be
 * unique, it needs the index, the registration-time refusal and this check
 * together, and a decision about the group-entity case first.
 */
export const assertIdentityAvailable = async (
  db: Db,
  candidate: { gst_number: string | null; mobile?: string | null },
  scope: { applicationId: bigint; memberId: bigint; userId: bigint },
): Promise<void> => {
  await assertMobileAvailable(db, candidate.mobile ?? null, scope.userId);

  const gstNumber = candidate.gst_number?.trim();
  if (!gstNumber) return;

  const member = await db.member.findFirst({
    where: { gst_number: gstNumber, deletedAt: null, id: { not: scope.memberId } },
    select: { id: true },
  });

  // The message names the field, never the other member. Who else holds a GSTIN
  // is not something an unauthenticated caller may learn by guessing numbers.
  if (member) {
    throw new AppError({
      errorType: ERROR_TYPES.CONFLICT,
      messageKey: 'member.gstAlreadyRegistered',
      // `fields` (plural, keyed by the client's own field name) is the shape the
      // customer's ApiError reads, so this lands under the GSTIN input rather
      // than in the page-level alert. Same convention as auth.service.ts.
      details: { fields: { gst_number: 'member.gstAlreadyRegistered' } },
    });
  }

  const otherApplication = await db.membershipApplication.findFirst({
    where: {
      gst_number: gstNumber,
      deletedAt: null,
      status: { in: engine.OPEN_STATUSES },
      id: { not: scope.applicationId },
    },
    select: { id: true },
  });

  if (otherApplication) {
    throw new AppError({
      errorType: ERROR_TYPES.CONFLICT,
      messageKey: 'application.gstOnAnotherApplication',
      details: { fields: { gst_number: 'application.gstOnAnotherApplication' } },
    });
  }
};

/* -------------------------------------------------------------------------- */
/* Correcting the form (D-16)                                                  */
/* -------------------------------------------------------------------------- */

const notFound = (messageKey: string): AppError =>
  new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey });

/** A missing value the applicant has to supply, named on the field it belongs to. */
const required = (field: string): AppError =>
  new AppError({
    errorType: ERROR_TYPES.VALIDATION_ERROR,
    messageKey: 'validation.requiredFields',
    details: { fields: { [field]: 'validation.requiredFields' } },
  });

/**
 * The registered office, resolved against the masters exactly as registration
 * resolves it.
 *
 * The names are stored beside the ids because `MemberAddresses` keeps both: the
 * id is the join, the name is what the address READ as on the day it was
 * captured, which is what a letter gets printed from and what an admin sees if
 * the master is later renamed. Registration writes both; a correction that
 * wrote only the ids would leave an address whose printed form belongs to the
 * old state.
 *
 * `city` falls back to the state's name when the applicant names no city — same
 * rule as `register.service.ts`, because the column is NOT NULL and half the
 * world's addresses do not have a separate city line.
 */
interface ResolvedLocation {
  countryId: bigint;
  stateId: bigint;
  cityId: bigint | null;
  countryName: string;
  stateName: string;
  cityName: string;
}

const resolveLocation = async (
  db: Db,
  wanted: { countryId: string | null; stateId: string | null; cityId: string | null },
): Promise<ResolvedLocation> => {
  if (!wanted.countryId) throw required('country_id');
  if (!wanted.stateId) throw required('state_id');

  const countryId = BigInt(wanted.countryId);
  const stateId = BigInt(wanted.stateId);
  const cityId = wanted.cityId ? BigInt(wanted.cityId) : null;

  const [country, state] = await Promise.all([
    db.country.findFirst({ where: { id: countryId, deletedAt: null, is_active: true } }),
    db.state.findFirst({
      // `country_id` in the WHERE, not checked afterwards: a state that exists
      // but sits under a different country is not a state this address may use,
      // and saying "that state no longer exists" is the honest answer to asking
      // for a pair that never existed.
      where: { id: stateId, country_id: countryId, deletedAt: null, is_active: true },
    }),
  ]);

  if (!country) throw notFound('masters.countryNotFound');
  if (!state) throw notFound('masters.stateNotFound');

  const city = cityId
    ? await db.city.findFirst({
        where: { id: cityId, state_id: stateId, deletedAt: null, is_active: true },
      })
    : null;

  if (cityId && !city) throw notFound('masters.cityNotFound');

  return {
    countryId,
    stateId,
    cityId: city ? city.id : null,
    countryName: country.name,
    stateName: state.name,
    cityName: city?.name ?? state.name,
  };
};

/** Only the submitted keys, for the audit row's before/after pair. */
const pick = (
  values: CorrectableFieldValues,
  keys: readonly CorrectableField[],
): Record<string, unknown> =>
  Object.fromEntries(keys.map((key) => [key, values[key]])) as Record<string, unknown>;

/**
 * Edit any field on the form, while the application is waiting on the applicant.
 *
 * The gate is the application's STATUS, and only that (D-16). It is not "which
 * documents were flagged" any more, and it is no longer the four columns that
 * happened to live on the snapshot: the reviewer writes one note saying what is
 * wrong, and a note about a name that does not match a licence — or an address
 * the courier could not find, or a mobile nobody answers — has to be actionable.
 * The previous rule refused those corrections with a 422 listing an empty or
 * near-empty set of editable fields: an error message telling the applicant they
 * may change nothing, on a page whose whole purpose is changing something.
 *
 * What is still refused is a bad VALUE rather than a forbidden field: a GSTIN or
 * a mobile that belongs to somebody else is a 409 here (D-17) instead of a
 * failed approval transaction three weeks later, and an id naming a retired
 * master is a 404 rather than a foreign key error.
 *
 * **Where each field lands.** The form is one object; the record is four tables,
 * and the correction has to put every value back where registration put it:
 *
 *  - `MembershipApplications` — the frozen snapshot. `company_name`,
 *    `pan_number`, `gst_number`, `legal_name`, `business_type`,
 *    `trade_license_no`, `website`, `about`, and `category_id` for the primary
 *    membership category.
 *  - `Members` — company facts with no snapshot column: `gstin_holder`,
 *    `company_category`, `landline`, `company_type_id`, and the many-to-many
 *    category claims.
 *  - `MemberAddresses` — the one `REGISTERED` row, ids and names together.
 *  - `Users` — the mobile, which is the login's `phone`.
 *
 * The three columns that exist in two places (`company_name`, `gst_number`,
 * `pan_number`) are written to the SNAPSHOT ONLY, and that asymmetry is
 * deliberate. `activation.service.ts` copies the approved snapshot onto the
 * member, so those three reach the member record the moment a reviewer accepts
 * them and never before. The fields written straight to `Members` have no such
 * path — there is no snapshot column for a landline — and the member is still
 * `DRAFT` and invisible to the directory while an application of theirs is in
 * `RETURNED_FOR_CORRECTION`, so nothing unreviewed is on display either way.
 *
 * `Users.full_name` is deliberately NOT re-derived from a corrected company
 * name. Registration seeds it from the company name because a login has to be
 * called something before anyone has typed a person's name; overwriting it here
 * would silently rename an account from a field that is not the account's name.
 */
export const correctFields = async (
  token: string,
  input: CorrectApplicationInput,
  context: PublicContext,
): Promise<PublicApplicationView> => {
  const application = await loadForToken(prisma, token, { assertCorrectable: true });

  const before = fieldsOf(application);
  const submitted = Object.keys(input) as CorrectableField[];
  const address = registeredAddressOf(application);

  /* --- values that only make sense against what is already stored ------- */

  /*
    The GSTIN pair, resolved the way registration resolves it.

    `gstin_holder` lives on the member and `gst_number` on the snapshot, so a
    PATCH carrying one of them has to be read against the stored other. Two
    rules, both from `register.service.ts`: a holder must have a number, and a
    non-holder stores NULL rather than whatever was typed before the box was
    unticked — otherwise unticking it would leave an orphaned GSTIN on the
    snapshot for the approval to copy onto a member who says they have none.
  */
  const gstinHolder = input.gstin_holder ?? before.gstin_holder;
  const submittedGst = input.gst_number !== undefined ? (input.gst_number ?? null) : null;
  const effectiveGst = input.gst_number !== undefined ? submittedGst : before.gst_number;

  if (gstinHolder && !effectiveGst) throw required('gst_number');

  /*
    A number without the box ticked is a contradiction, not a value to drop.

    Storing NULL and answering "Saved" would be the worst of both: the applicant
    typed a GSTIN, was told it was accepted, and the reviewer would see a blank
    where they had complained about one. Refused on the field instead, so the
    page says which of the two the applicant meant.
  */
  if (!gstinHolder && submittedGst) {
    throw new AppError({
      errorType: ERROR_TYPES.VALIDATION_ERROR,
      messageKey: 'application.gstNeedsHolder',
      details: { fields: { gst_number: 'application.gstNeedsHolder' } },
    });
  }

  // Unticking the box clears a number nobody sent — otherwise the snapshot would
  // keep a GSTIN for the approval to copy onto a member who says they have none.
  const storedGst = gstinHolder ? effectiveGst : null;

  /* --- masters, proved live before anything is written ------------------ */

  const companyTypeId =
    input.company_type_id !== undefined ? BigInt(input.company_type_id) : undefined;

  if (companyTypeId !== undefined) {
    const companyType = await prisma.companyType.findFirst({
      where: { id: companyTypeId, deletedAt: null, is_active: true },
    });

    if (!companyType) throw notFound('masters.companyTypeNotFound');
  }

  let categoryIds: bigint[] | undefined;

  if (input.category_ids !== undefined) {
    categoryIds = input.category_ids.map((id) => BigInt(id));

    const categories = await prisma.membershipCategory.findMany({
      where: { id: { in: categoryIds }, deletedAt: null, is_active: true },
      select: { id: true },
    });

    // Length, not membership: a duplicate id in the payload would otherwise pass
    // a naive `every` while claiming fewer categories than the applicant chose.
    if (categories.length !== new Set(categoryIds.map(String)).size) {
      throw notFound('masters.categoryNotFound');
    }
  }

  /*
    The address, re-resolved whenever any part of it moves.

    A state change with no city named is the case worth spelling out: the city
    already on file belongs to the OLD state, so keeping it would produce an
    address that contradicts itself. `resolveLocation` refuses a city that does
    not sit under the state, so the effective city is dropped rather than
    carried when the state changes — which is exactly what the form does when
    its state select is changed and its city select clears.
  */
  const touchesLocation =
    input.country_id !== undefined || input.state_id !== undefined || input.city_id !== undefined;
  const touchesAddress =
    touchesLocation ||
    input.address_line1 !== undefined ||
    input.address_line2 !== undefined ||
    input.pincode !== undefined;

  const stateUnchanged = input.state_id === undefined || input.state_id === before.state_id;

  const location =
    touchesLocation || (touchesAddress && !address)
      ? await resolveLocation(prisma, {
          countryId: input.country_id ?? before.country_id,
          stateId: input.state_id ?? before.state_id,
          cityId: input.city_id ?? (stateUnchanged ? before.city_id : null),
        })
      : null;

  /* --- what each table is asked to store -------------------------------- */

  const applicationData: Prisma.MembershipApplicationUpdateInput = {};

  if (input.company_name !== undefined) applicationData.company_name = input.company_name;
  if (input.pan_number !== undefined) applicationData.pan_number = input.pan_number;
  if (input.legal_name !== undefined) applicationData.legal_name = input.legal_name ?? null;
  if (input.business_type !== undefined)
    applicationData.business_type = input.business_type ?? null;
  if (input.trade_license_no !== undefined) {
    applicationData.trade_license_no = input.trade_license_no ?? null;
  }
  if (input.website !== undefined) applicationData.website = input.website ?? null;
  if (input.about !== undefined) applicationData.about = input.about ?? null;
  if (input.gst_number !== undefined || input.gstin_holder !== undefined) {
    applicationData.gst_number = storedGst;
  }
  // The snapshot names ONE category — the class applied for — while the member
  // claims many. Registration takes the first; a correction that reorders them
  // is a correction to that choice, so the same rule applies here.
  if (categoryIds && categoryIds.length > 0) {
    applicationData.category = { connect: { id: categoryIds[0] } };
  }

  const memberData: Prisma.MemberUpdateInput = {};

  if (input.gstin_holder !== undefined) memberData.gstin_holder = input.gstin_holder;
  if (input.company_category !== undefined) {
    memberData.company_category = input.company_category ?? null;
  }
  if (input.landline !== undefined) memberData.landline = input.landline ?? null;
  if (companyTypeId !== undefined) memberData.company_type = { connect: { id: companyTypeId } };

  const updated = await prisma.$transaction(async (tx) => {
    await assertStillCorrectable(tx, token, application.id);

    // Inside the transaction, behind the row lock, so the answer is still true
    // when the write lands. Outside it, a check and its write are two moments a
    // competing registration can slip between.
    await assertIdentityAvailable(
      tx,
      { gst_number: storedGst, mobile: input.mobile ?? null },
      {
        applicationId: application.id,
        memberId: application.member_id,
        userId: application.user_id,
      },
    );

    if (Object.keys(applicationData).length > 0) {
      await repo.updateApplication(tx, application.id, applicationData);
    }

    if (Object.keys(memberData).length > 0) {
      await memberRepo.updateMember(tx, application.member_id, memberData);
    }

    if (categoryIds) {
      await memberRepo.setMemberCategories(tx, application.member_id, categoryIds);
    }

    if (touchesAddress) {
      const line1 = input.address_line1 ?? before.address_line1;
      const pincode = input.pincode ?? before.pincode;

      if (!line1) throw required('address_line1');
      if (!pincode) throw required('pincode');

      if (address) {
        await memberRepo.updateAddress(tx, address.id, {
          line1,
          line2: input.address_line2 !== undefined ? input.address_line2 : before.address_line2,
          pincode,
          ...(location
            ? {
                country: location.countryName,
                state: location.stateName,
                city: location.cityName,
                country_ref: { connect: { id: location.countryId } },
                state_ref: { connect: { id: location.stateId } },
                city_ref: location.cityId
                  ? { connect: { id: location.cityId } }
                  : { disconnect: true },
              }
            : {}),
        });
      } else if (location) {
        /*
          No registered address to correct.

          Registration always writes one, so this is a repair rather than a
          normal path — but refusing would leave an applicant unable to give an
          address they were asked for. The row is created rather than demanded,
          and `clearPrimaryAddresses` runs first because
          `MemberAddresses_one_primary_per_member` is a partial unique index: a
          second primary is a constraint violation, not a mess to tidy later.
        */
        await memberRepo.clearPrimaryAddresses(tx, application.member_id);
        await memberRepo.createAddress(tx, {
          member_id: application.member_id,
          address_type: AddressType.REGISTERED,
          line1,
          line2: input.address_line2 ?? null,
          pincode,
          country: location.countryName,
          state: location.stateName,
          city: location.cityName,
          country_id: location.countryId,
          state_id: location.stateId,
          city_id: location.cityId,
          is_primary: true,
        });
      }
    }

    if (input.mobile !== undefined) {
      await authRepo.updateUser(tx, application.user_id, { phone: input.mobile });
    }

    const detail = await repo.findApplicationDetail(tx, application.id);

    await writeAudit(tx, {
      actorType: ACTOR_TYPES.MEMBER,
      actorId: application.user_id,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
      action: AUDIT_ACTIONS.APPLICATION_CORRECTED,
      entityName: 'MembershipApplications',
      entityId: application.id,
      // Read back rather than echoed. The audit row then records what the
      // database now holds, which is not always what the PATCH said: unticking
      // the GSTIN box clears a number nobody sent, and a state change can drop
      // a city nobody mentioned.
      before: pick(before, submitted),
      after: { ...(detail ? pick(fieldsOf(detail), submitted) : {}), via: 'resubmit_link' },
    });

    return detail;
  });

  return buildView(updated ?? application);
};

/* -------------------------------------------------------------------------- */
/* Replacing a flagged document (D-12)                                         */
/* -------------------------------------------------------------------------- */

export interface IncomingFile {
  originalName: string;
  buffer: Buffer;
  declaredMime: string;
}

/**
 * Replace one flagged file.
 *
 * Two guards, in this order:
 *
 *  - **Only a flagged type.** A `VERIFIED` document survives a rejection (D-12)
 *    and is not asked for again; accepting a replacement for it would push a
 *    verified file back to `PENDING` and undo work the reviewer had finished.
 *  - **The same byte-level validation as every other upload.** Size, emptiness
 *    and a sniffed MIME that must match the allowlist — `storeApplicationFile`
 *    is the identical call the registration form makes. The rules do not get
 *    weaker because the caller has no session; if anything this is the path that
 *    needs them most.
 *
 * The row is appended, not overwritten. `requires_reupload` is then cleared on
 * every live row of that type — the debt is settled, while the refused version
 * and its reason stay readable in the history.
 */
export const replaceDocument = async (
  token: string,
  documentTypeCode: string,
  file: IncomingFile,
  context: PublicContext,
  requestedSide?: DocumentSideValue,
): Promise<PublicApplicationView> => {
  const application = await loadForToken(prisma, token, { assertCorrectable: true });

  const rows = await currentDocuments(application);

  /*
    Match the face too, when one was named.

    Without a side the first flagged face of that type is replaced, which is the
    right behaviour for a single-sided document and for a client that predates
    two-sided types. A two-sided document names the face it is replacing.
  */
  const current = rows.find(
    (row) =>
      row.code === documentTypeCode &&
      (requestedSide ? row.side === requestedSide : row.document?.requires_reupload === true),
  );

  if (!current?.document?.requires_reupload) {
    throw conflict('application.documentNotFlagged', { document_type: documentTypeCode });
  }

  // Validates first, stores second — nothing reaches disk until the bytes are
  // the kind of file this document type accepts.
  const stored = await documentService.storeApplicationFile({
    applicationId: application.id,
    documentTypeCode,
    originalName: file.originalName,
    buffer: file.buffer,
    declaredMime: file.declaredMime,
    requestedSide: current.side,
  });

  try {
    const updated = await prisma.$transaction(async (tx) => {
      await assertStillCorrectable(tx, token, application.id);

      const previous = await tx.applicationDocument.findFirst({
        where: {
          application_id: application.id,
          document_type_id: stored.document_type_id,
          side: stored.side,
          deletedAt: null,
        },
        orderBy: { version: 'desc' },
        select: { version: true },
      });

      const created = await tx.applicationDocument.create({
        data: {
          application_id: application.id,
          document_type_id: stored.document_type_id,
          side: stored.side,
          file_path: stored.file_path,
          original_name: stored.original_name,
          mime_type: stored.mime_type,
          size_bytes: stored.size_bytes,
          checksum_sha256: stored.checksum_sha256,
          version: (previous?.version ?? 0) + 1,
          // Back to PENDING, which is the point: a replaced file has not been
          // looked at, and the stage-1 queue must see it as work again.
          verification_status: DocumentVerificationStatus.PENDING,
          requires_reupload: false,
        },
      });

      await tx.applicationDocument.updateMany({
        where: {
          application_id: application.id,
          document_type_id: stored.document_type_id,
          side: stored.side,
          requires_reupload: true,
          deletedAt: null,
        },
        data: { requires_reupload: false },
      });

      await writeAudit(tx, {
        actorType: ACTOR_TYPES.MEMBER,
        actorId: application.user_id,
        ip: context.ip,
        userAgent: context.userAgent,
        requestId: context.requestId,
        action: AUDIT_ACTIONS.DOCUMENT_UPLOADED,
        entityName: 'ApplicationDocuments',
        entityId: created.id,
        after: {
          document_type: documentTypeCode,
          version: created.version,
          checksum: stored.checksum_sha256,
          via: 'resubmit_link',
        },
      });

      return repo.findApplicationDetail(tx, application.id);
    });

    return buildView(updated ?? application);
  } catch (error) {
    // The row never committed, so the bytes are an orphan. Best-effort removal;
    // a failure here is logged, never surfaced — the caller's problem is the
    // upload that failed, not our housekeeping.
    await storage.current.delete(stored.file_path).catch((cleanupError: unknown) => {
      logger.error('document.orphanCleanupFailed', {
        key: stored.file_path,
        detail: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    });

    throw error;
  }
};

/* -------------------------------------------------------------------------- */
/* Resubmitting (D-11, OQ-4)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Send the corrected application back.
 *
 * **It increments `resubmission_count`, and it is the only place that does.**
 * The counter records corrections the applicant has ALREADY made, which is
 * exactly what `resolveRejection` and `assertResubmissionAllowed` compare
 * against (D-15). The reject transaction deliberately does not touch it: a
 * rejection offers an attempt, and this is where the applicant spends one. When
 * both sides assumed the other owned this, the counter never moved and the cap
 * never fired — an applicant could resubmit for ever.
 *
 * Two things it deliberately does NOT do:
 *
 *  - **It does not revoke the link.** The application may be rejected again, and
 *    the applicant would then need a link they no longer have. The reject
 *    transaction reissues; approval and final rejection revoke.
 *  - **It does not preserve the original `submitted_at`.** A resubmission
 *    re-enters stage 1 as new work with a fresh clock (OQ-4), and the stage SLA
 *    is measured from that column — keeping the first submission's date would
 *    show a corrected application as three weeks overdue the moment it arrived.
 */
export const resubmit = async (
  token: string,
  context: PublicContext,
): Promise<PublicApplicationView> => {
  const application = await loadForToken(prisma, token, { assertCorrectable: true });

  const outstanding = (await currentDocuments(application))
    .filter((row) => row.document?.requires_reupload === true)
    .map((row) => row.label);

  if (outstanding.length > 0) {
    throw new AppError({
      errorType: ERROR_TYPES.VALIDATION_ERROR,
      messageKey: 'application.documentsStillFlagged',
      details: { documents: outstanding },
    });
  }

  // Belt and braces. The reject transaction closes the application at the cap,
  // so an application in this status is under it — unless a super admin lowered
  // the setting in between, which is exactly when a guard earns its keep.
  engine.assertResubmissionAllowed(application.resubmission_count, await resubmissionLimit());

  const workflow = await repo.findActiveWorkflow(
    prisma,
    ApprovalSubjectType.MEMBERSHIP_APPLICATION,
  );
  if (!workflow || workflow.stages.length === 0) {
    throw conflict('application.workflowHasNoStages');
  }

  const firstStage = engine.stageForResubmission(workflow.stages);
  engine.assertApplicantMay(application.status, ApplicationStatus.SUBMITTED);

  const updated = await prisma.$transaction(async (tx) => {
    await assertStillCorrectable(tx, token, application.id);

    /*
     * Checked again on the way out, not only on the way in (D-17).
     *
     * The applicant may have corrected the GSTIN days ago and left the tab open,
     * and somebody else may have registered with it since. Re-checking here
     * means the queue never receives an application that is already guaranteed
     * to fail its own approval — which is the entire point of validating at
     * correction time rather than at approval time.
     */
    await assertIdentityAvailable(
      tx,
      { gst_number: application.gst_number, mobile: application.user.phone },
      {
        applicationId: application.id,
        memberId: application.member_id,
        userId: application.user_id,
      },
    );

    await repo.updateApplication(tx, application.id, {
      status: ApplicationStatus.SUBMITTED,
      submitted_at: new Date(),
      current_stage: { connect: { id: firstStage.id } },
      // Inside the transaction and as an atomic increment, not a read-then-write:
      // two tabs pressing Send must not both spend the same attempt.
      resubmission_count: { increment: 1 },
    });

    const openRequest = await repo.findOpenRequestForApplication(tx, application.id);

    if (openRequest) {
      await repo.updateApprovalRequest(tx, openRequest.id, {
        status: ApprovalRequestStatus.OPEN,
        current_stage: { connect: { id: firstStage.id } },
        closed_at: null,
      });
    } else {
      // The reject transaction closes the request as RETURNED, so this is the
      // normal path rather than the exception.
      await repo.createApprovalRequest(tx, {
        workflow_id: workflow.id,
        subject_type: ApprovalSubjectType.MEMBERSHIP_APPLICATION,
        application_id: application.id,
        current_stage_id: firstStage.id,
        status: ApprovalRequestStatus.OPEN,
      });
    }

    await queueNotifications(tx, ['EMAIL', 'IN_APP'], {
      templateCode: 'application.submitted',
      userId: application.user_id,
      memberId: application.member_id,
      toAddress: application.user.email,
      payload: {
        company_name: application.company_name,
        application_number: application.application_number ?? '',
        stage_name: firstStage.name,
        track_url: resubmitLinkFor(token),
      },
    });

    await writeAudit(tx, {
      actorType: ACTOR_TYPES.MEMBER,
      actorId: application.user_id,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
      action: AUDIT_ACTIONS.APPLICATION_SUBMITTED,
      entityName: 'MembershipApplications',
      entityId: application.id,
      before: { status: application.status },
      after: {
        status: ApplicationStatus.SUBMITTED,
        application_number: application.application_number,
        resubmission: true,
        // The attempt this resubmission just spent — the pre-increment value
        // read from the row we loaded, plus the one we have now written.
        attempt: application.resubmission_count + 1,
        via: 'resubmit_link',
      },
    });

    return repo.findApplicationDetail(tx, application.id);
  });

  return buildView(updated ?? application);
};

/* -------------------------------------------------------------------------- */
/* "I lost the email" (OQ-2)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The itemised payload the rejection email is rendered from.
 *
 * Exported because three callers must produce the identical message: the reject
 * transaction, this resend, and the one-off backfill. The renderer is
 * deliberately loop-free (`renderer.ts`), so the per-document list is flattened
 * to a string here rather than iterated in the template — a template that could
 * loop over admin-authored content is a server-side template injection waiting
 * to be written.
 *
 * The key set matches the one `application.service.ts` sends on a rejection,
 * exactly. Two senders filling the same template with different key names is how
 * a resent email quietly loses half its content: an unknown placeholder renders
 * as an empty string, so the drift would show up as a blank line in someone's
 * inbox rather than as a failure anywhere a developer would see it. The seed
 * (`prisma/seed/notificationTemplates.ts`) documents that contract.
 */
export const buildRejectionPayload = (input: {
  application: Pick<
    MembershipApplication,
    'company_name' | 'application_number' | 'resubmission_count'
  >;
  reviewerNote: string | null;
  flagged: { document_type: string; label: string; remarks: string | null }[];
  limit: number;
  url: string;
}): Record<string, string> => {
  const remaining =
    input.limit > 0 ? Math.max(input.limit - input.application.resubmission_count, 0) : 0;

  return {
    company_name: input.application.company_name,
    application_number: input.application.application_number ?? '',
    remarks: input.reviewerNote ?? '',
    document_reasons: input.flagged
      .map((row) => `${row.label}: ${(row.remarks ?? '').trim() || 'no reason recorded'}`)
      .join('\n'),
    document_count: String(input.flagged.length),
    /** Corrections spent so far — the reject transaction has already counted this one. */
    attempt: String(input.application.resubmission_count),
    max_resubmissions: String(input.limit),
    // Empty string rather than a number when the association set no cap: a
    // template that prints nothing beats one that promises something.
    attempts_remaining: input.limit > 0 ? String(remaining) : '',
    resubmit_url: input.url,
  };
};

/**
 * Issue a fresh link for one application and email the rejection again.
 *
 * Exported because two callers need exactly this and must not drift apart: the
 * "resend my link" endpoint below, and the one-off backfill for applications
 * that were already sitting in `RETURNED_FOR_CORRECTION` when this shipped
 * (OQ-5) and have no way back in at all.
 *
 * A fresh token rather than the old one re-sent. The plaintext was never stored,
 * so re-sending it is not possible even if it were desirable — and reissuing has
 * the better property anyway: whatever is in the applicant's inbox from before,
 * the newest email is the one that works.
 *
 * Runs on the caller's `db`, which MUST be a transaction: a link that was
 * emailed but never written is a URL to nothing.
 */
export const reissueCorrectionLink = async (
  tx: Db,
  applicationId: bigint,
  options: {
    /** Recorded verbatim in the audit row. Says which of the callers this was. */
    reason: string;
    actorType: (typeof ACTOR_TYPES)[keyof typeof ACTOR_TYPES];
    /**
     * Who to record. Defaults to the applicant for a `MEMBER` reissue, which is
     * the only actor an anonymous resend has. An admin caller passes their own
     * id — an `ADMIN` audit row with a NULL actor names the authority without
     * naming the person, which is the half of the question that matters least.
     */
    actorId?: bigint | null;
    context: PublicContext;
  },
): Promise<{ url: string } | null> => {
  const detail = await repo.findApplicationDetail(tx, applicationId);

  if (!detail || detail.status !== ApplicationStatus.RETURNED_FOR_CORRECTION) {
    return null;
  }

  const limit = await resubmissionLimit();
  const flagged = (await currentDocuments(detail))
    .filter((row) => row.document?.requires_reupload === true)
    .map((row) => ({
      document_type: row.code,
      label: row.label,
      remarks: row.document?.remarks ?? null,
    }));

  const issued = await issueApplicationAccessToken(tx, applicationId);

  // EMAIL only. The in-app bell already carries the original rejection, and a
  // second copy of it because someone lost an email is noise in a feed they were
  // never reading — the point of the resend is the inbox.
  await queueNotifications(tx, ['EMAIL'], {
    templateCode: 'application.rejected',
    userId: detail.user_id,
    memberId: detail.member_id,
    toAddress: detail.user.email,
    payload: buildRejectionPayload({
      application: detail,
      reviewerNote: reviewerNoteOf(detail),
      flagged,
      limit,
      url: issued.url,
    }),
  });

  await writeAudit(tx, {
    actorType: options.actorType,
    actorId: options.actorId ?? (options.actorType === ACTOR_TYPES.MEMBER ? detail.user_id : null),
    ip: options.context.ip,
    userAgent: options.context.userAgent,
    requestId: options.context.requestId,
    action: AUDIT_ACTIONS.APPLICATION_LINK_REISSUED,
    entityName: 'MembershipApplications',
    entityId: applicationId,
    after: { reason: options.reason },
  });

  return { url: issued.url };
};

/**
 * Resend the link to an address, without confirming whether that address exists.
 *
 * The response is identical either way (security.md §2, enumeration): the caller
 * is told what happens *if* the address has an application waiting on a
 * correction, and nothing about whether this one does. That is why the whole
 * body of this function can fall through silently — the absence of an email is
 * the only signal, and it is a signal only the real owner of the inbox sees.
 *
 * Narrowed to `PENDING_APPROVAL` users on purpose. An `ACTIVE` member has a
 * password and a portal; handing them a passwordless link to an application row
 * would be a second, weaker way into an account that already has a first.
 */
export const resendLink = async (email: string, context: PublicContext): Promise<void> => {
  const user = await prisma.user.findFirst({
    where: { email, deletedAt: null, status: UserStatus.PENDING_APPROVAL },
    select: { id: true },
  });

  if (!user) {
    logger.info('application.resendLinkNoMatch', { reason: 'no_pending_application' });
    return;
  }

  const application = await prisma.membershipApplication.findFirst({
    where: {
      user_id: user.id,
      status: ApplicationStatus.RETURNED_FOR_CORRECTION,
      deletedAt: null,
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

  if (!application) {
    logger.info('application.resendLinkNoMatch', { reason: 'no_returned_application' });
    return;
  }

  await prisma.$transaction((tx) =>
    reissueCorrectionLink(tx, application.id, {
      reason: 'applicant_requested_resend',
      actorType: ACTOR_TYPES.MEMBER,
      context,
    }),
  );
};

/* -------------------------------------------------------------------------- */
/* Super admin: clearing the counter (D-13)                                    */
/* -------------------------------------------------------------------------- */

export interface AdminActor {
  id: bigint;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

/**
 * Give an applicant their attempts back, on an application they still hold.
 *
 * The sibling of `reopenApplication` below, and the division between them is by
 * the application's status rather than by the admin's intent — which is what
 * keeps each one obvious. This is for an application sitting in
 * `RETURNED_FOR_CORRECTION` one refusal away from closing: nothing about the
 * application changes except the number of chances left, and the applicant is
 * not emailed, because from their side nothing happened.
 *
 * A `REJECTED` application is refused here and pointed at reopen. Clearing a
 * counter on a closed application would be a silent no-op wearing the costume of
 * a fix — the admin would see "counter cleared", the applicant would still have
 * a dead link, and nobody would find out until the support call.
 */
export const resetResubmissionCount = async (
  applicationId: bigint,
  input: ResetResubmissionsInput,
  actor: AdminActor,
): Promise<{ id: string; resubmission_count: number }> => {
  const application = await repo.findApplicationById(prisma, applicationId);

  if (!application) {
    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'application.notFound' });
  }

  if (application.status === ApplicationStatus.REJECTED) {
    throw conflict('application.closedUseReopen', { status: application.status });
  }

  if (application.resubmission_count === 0) {
    throw conflict('application.counterAlreadyClear');
  }

  await prisma.$transaction(async (tx) => {
    await repo.updateApplication(tx, applicationId, { resubmission_count: 0 });

    await writeAudit(tx, {
      actorType: ACTOR_TYPES.ADMIN,
      actorId: actor.id,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
      action: AUDIT_ACTIONS.APPLICATION_RESUBMISSIONS_RESET,
      entityName: 'MembershipApplications',
      entityId: applicationId,
      before: { resubmission_count: application.resubmission_count },
      after: { resubmission_count: 0, reason: input.reason },
    });
  });

  return { id: applicationId.toString(), resubmission_count: 0 };
};

/* -------------------------------------------------------------------------- */
/* Super admin: reopening a closed application (D-18)                          */
/* -------------------------------------------------------------------------- */

/**
 * Undo a final rejection, and put the applicant back where they were.
 *
 * D-5 and D-13 pulled in opposite directions: the cap closes an application
 * "permanently", but a super admin may reset the counter "for a genuine case".
 * D-18 settles it — the cap is a rule the system enforces, not a fact about the
 * world, and the association must be able to overrule its own rule when the
 * applicant was right and the reviewer was not. What it is NOT is a reviewer
 * action: it is guarded by `settings.manage` plus the super-admin floor, exactly
 * like editing the cap itself, because it is the same authority.
 *
 * One transaction, six statements, and each one is load-bearing:
 *
 *  1. **Status back to `RETURNED_FOR_CORRECTION`**, with `decided_at` cleared —
 *     there is no decision standing any more, and a closed date on a live
 *     application would be read as one by every screen and report that has it.
 *  2. **`resubmission_count` to 0.** Reopening without this hands the applicant
 *     a form whose first submission is refused by `assertResubmissionAllowed`:
 *     an invitation that bounces.
 *  3. **`requires_reupload` untouched.** The reviewer's ✗ marks are still what
 *     they were, and re-deciding which documents are wrong is not a super
 *     admin's job. The applicant sees the same list they saw before it closed.
 *  4. **The approval request reopened at Stage 1** (D-11 — a resubmission always
 *     re-enters at the first stage). The reject transaction closed it as
 *     `REJECTED`; leaving it closed would strand the application outside the
 *     workflow entirely.
 *  5. **A fresh token**, because the reject transaction revoked the old one. The
 *     link in the applicant's inbox is dead, so reopening without reissuing
 *     reopens something nobody can reach.
 *  6. **The correction email re-sent**, carrying that link. An application that
 *     reopens in silence is an application nobody corrects.
 *
 * A seventh, off to the side: the applicant's login goes back to
 * `PENDING_APPROVAL`, because the final rejection had moved it to `INACTIVE`
 * (D-19) and an open application belonging to a deactivated account is a state
 * nothing else in the system knows how to read.
 *
 * `reissueCorrectionLink` does 5 and 6 and is called after the status write on
 * purpose — it refuses to act on anything that is not `RETURNED_FOR_CORRECTION`,
 * so the order is what makes it agree to run at all.
 */
export const reopenApplication = async (
  applicationId: bigint,
  input: ReopenApplicationInput,
  actor: AdminActor,
): Promise<{ id: string; status: ApplicationStatus; resubmission_count: number }> => {
  const application = await repo.findApplicationById(prisma, applicationId);

  if (!application) {
    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'application.notFound' });
  }

  // Only a CLOSED application is reopenable. An approved one is a member with a
  // code, a term and an invoice, and unwinding that is not a status change.
  if (application.status !== ApplicationStatus.REJECTED) {
    throw conflict('application.notClosed', { status: application.status });
  }

  const workflow = await repo.findActiveWorkflow(
    prisma,
    ApprovalSubjectType.MEMBERSHIP_APPLICATION,
  );
  if (!workflow || workflow.stages.length === 0) {
    throw conflict('application.workflowHasNoStages');
  }

  const firstStage = engine.stageForResubmission(workflow.stages);

  await prisma.$transaction(async (tx) => {
    /*
     * The same `FOR UPDATE` lock every write on this row takes.
     *
     * Without it two super admins could reopen the same application at once and
     * both call `issueApplicationAccessToken`, which revokes what came before —
     * the applicant would receive two emails and the first link would already be
     * dead when they clicked it.
     */
    await tx.$queryRaw`SELECT id FROM "MembershipApplications" WHERE id = ${applicationId} FOR UPDATE`;

    const fresh = await tx.membershipApplication.findFirst({
      where: { id: applicationId, deletedAt: null },
      select: { status: true, resubmission_count: true },
    });

    if (fresh?.status !== ApplicationStatus.REJECTED) {
      throw conflict('application.notClosed', { status: fresh?.status ?? null });
    }

    /*
     * Has the applicant already moved on?
     *
     * D-19 lets a finally-rejected applicant apply again on the same login, so by
     * the time a super admin gets to this button there may be a newer application
     * in flight. Reopening the old one would then put two open applications on
     * one user and violate `MembershipApplications_one_open_per_user` — a partial
     * unique index, so the failure would be a raw constraint error rather than
     * anything an admin could act on. Named here instead, and it names the right
     * next step: the newer application is the live one.
     */
    const alreadyOpen = await repo.findOpenApplicationForUser(tx, application.user_id);
    if (alreadyOpen) {
      throw conflict('application.applicantHasOpenApplication', {
        open_application_id: alreadyOpen.id.toString(),
      });
    }

    await repo.updateApplication(tx, applicationId, {
      status: ApplicationStatus.RETURNED_FOR_CORRECTION,
      resubmission_count: 0,
      decided_at: null,
      // Waiting on the applicant, not on a reviewer — so it is in nobody's queue,
      // exactly as a fresh rejection leaves it.
      current_stage: { disconnect: true },
    });

    const openRequest = await repo.findOpenRequestForApplication(tx, applicationId);

    if (openRequest) {
      await repo.updateApprovalRequest(tx, openRequest.id, {
        status: ApprovalRequestStatus.OPEN,
        current_stage: { connect: { id: firstStage.id } },
        closed_at: null,
      });
    } else {
      await repo.createApprovalRequest(tx, {
        workflow_id: workflow.id,
        subject_type: ApprovalSubjectType.MEMBERSHIP_APPLICATION,
        application_id: applicationId,
        current_stage_id: firstStage.id,
        status: ApprovalRequestStatus.OPEN,
      });
    }

    /*
     * The applicant's login goes back to `PENDING_APPROVAL`, the exact inverse of
     * what the rejection did to it (D-19).
     *
     * Not cosmetic. `PENDING_APPROVAL` is what "this person has an application in
     * flight" means for a login with no password, and three things read it:
     * `resendLink` looks for exactly that status, so leaving the account
     * `INACTIVE` would reopen an application whose link could never be resent;
     * `register.service.ts` treats `INACTIVE` plus no open application as
     * permission to apply again, and this application is open again; and login
     * refuses `PENDING_APPROVAL` just as firmly as `INACTIVE`, so nothing is
     * opened up by the move.
     */
    await tx.user.update({
      where: { id: application.user_id },
      data: { status: UserStatus.PENDING_APPROVAL },
    });

    const reissued = await reissueCorrectionLink(tx, applicationId, {
      reason: `super_admin_reopened: ${input.reason}`,
      actorType: ACTOR_TYPES.ADMIN,
      actorId: actor.id,
      context: { ip: actor.ip, userAgent: actor.userAgent, requestId: actor.requestId },
    });

    if (!reissued) {
      // Unreachable — the status was written three statements ago inside this
      // transaction. Loud rather than silent, because the failure it would
      // otherwise produce is an application reopened with no way into it.
      throw conflict('application.linkReissueFailed');
    }

    await writeAudit(tx, {
      actorType: ACTOR_TYPES.ADMIN,
      actorId: actor.id,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
      action: AUDIT_ACTIONS.APPLICATION_REOPENED,
      entityName: 'MembershipApplications',
      entityId: applicationId,
      before: {
        status: ApplicationStatus.REJECTED,
        resubmission_count: fresh.resubmission_count,
      },
      after: {
        status: ApplicationStatus.RETURNED_FOR_CORRECTION,
        resubmission_count: 0,
        stage: firstStage.name,
        applicant_user_status: UserStatus.PENDING_APPROVAL,
        reason: input.reason,
      },
    });
  });

  return {
    id: applicationId.toString(),
    status: ApplicationStatus.RETURNED_FOR_CORRECTION,
    resubmission_count: 0,
  };
};
