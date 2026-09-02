import {
  AddressType,
  ApplicationStatus,
  ApprovalRequestStatus,
  ApprovalSubjectType,
  MemberStatus,
  Prisma,
  UserStatus,
  type Member,
  type User,
} from '@prisma/client';
import { ACTOR_TYPES, AUDIT_ACTIONS } from '@constant/audit.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { prisma } from '@db/prisma';
import { writeAudit } from '@helpers/audit';
import { generateDocumentNumber, calendarQuarter } from '@helpers/documentNumber';
import { storage } from '@helpers/storage';
import { logger } from '@logger/logger';
import { queueNotifications } from '@notifications/outbox';
import * as captcha from '@modules/auth/captcha.service';
import * as authRepo from '@modules/auth/auth.repository';
import { uploadFieldName } from '@modules/auth/register.constants';
import type { RegisterInput } from '@modules/auth/register.schema';
import * as appRepo from '@modules/application/application.repository';
import { issueApplicationAccessToken } from '@modules/application/application.tokens';
import * as engine from '@modules/application/approval.engine';
import * as documentService from '@modules/document/document.service';
import * as memberRepo from '@modules/member/member.repository';
import { AppError } from '@utils/appError';
import {
  describeSide,
  type DocumentSideValue,
  missingSides,
  sideForUpload,
} from '@modules/document/document.sides';
import { checklistFor } from '@modules/masters/masters.checklist';
interface RequestContext {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export interface RegistrationFile {
  code: string;
  /** Which face of the document this file is, decoded from the multipart field. */
  side: DocumentSideValue;
  originalName: string;
  buffer: Buffer;
  declaredMime: string;
}

const conflict = (key: string): AppError =>
  new AppError({ errorType: ERROR_TYPES.CONFLICT, messageKey: key });

const isUniqueViolation = (error: unknown, fragment: string): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002' &&
  String(error.meta?.target ?? '').includes(fragment);

const allocateApplicationNumber = (tx: Prisma.TransactionClient): Promise<string> => {
  const now = new Date();

  return generateDocumentNumber(tx, {
    prefix: 'APP',
    period: `${now.getUTCFullYear()}${String(calendarQuarter(now)).padStart(2, '0')}`,
    width: 4,
    separator: '',
  });
};

const cleanupStoredFiles = async (keys: string[]): Promise<void> => {
  await Promise.all(
    keys.map((key) =>
      storage.current.delete(key).catch(() => {
        /* best-effort */
      }),
    ),
  );
};

/**
 * What a re-application runs against: the login and the company record that
 * already exist for this email, both to be reused rather than duplicated.
 */
interface Reapplicant {
  user: Pick<User, 'id' | 'email'>;
  member: Member | null;
  /** The closed application this is a second attempt at. Audit only. */
  previousApplicationId: bigint | null;
}

/**
 * May this existing account apply again? (spec D-19)
 *
 * The problem being solved is a permanent lock-out. Registration creates the
 * login as `PENDING_APPROVAL` with no password; a final rejection now moves it
 * to `INACTIVE` (`application.service.ts`). Before D-19 the row stayed
 * `PENDING_APPROVAL` forever, which meant login refused it *and* this function's
 * predecessor returned silently for it — an address its owner could neither sign
 * in with nor register again, and no message anywhere saying so. The closure
 * email meanwhile invites them to "apply again from the start".
 *
 * The predicate is deliberately narrow, because `INACTIVE` is reachable by more
 * than one road. A real member deactivated by staff (`rbac.service.ts`) is also
 * `INACTIVE`, and letting a stranger who knows their address re-register would
 * reset that member's company record, categories and address to whatever the
 * stranger typed. So three things must ALL hold:
 *
 *  - **`INACTIVE`** — the account holds no live claim on anything.
 *  - **No password and no verified email** — this account has never been used to
 *    sign in, which is what distinguishes a rejected applicant from a real
 *    member who was switched off. A stranger cannot manufacture this state; only
 *    a rejection produces it.
 *  - **No application in `OPEN_STATUSES`** — the one-open-application rule
 *    (`MembershipApplications_one_open_per_user`, a partial unique index) is the
 *    database's opinion as well as ours. `REJECTED` is not in that set, which is
 *    why a second application is legal at all; checking it here means the
 *    applicant gets an answer rather than a constraint violation.
 *
 * Anything else returns NULL and the caller falls through to the same silent
 * success every other existing account gets. That silence is the point: the
 * response must not tell a caller which of these branches they landed in
 * (security.md §2).
 */
const resolveReapplicant = async (existing: {
  id: bigint;
  email: string;
  status: UserStatus;
  password_hash: string | null;
  email_verified_at: Date | null;
}): Promise<Reapplicant | null> => {
  if (
    existing.status !== UserStatus.INACTIVE ||
    existing.password_hash !== null ||
    existing.email_verified_at !== null
  ) {
    return null;
  }

  const open = await appRepo.findOpenApplicationForUser(prisma, existing.id);
  if (open) {
    logger.info('auth.reapplyBlockedByOpenApplication', { userId: existing.id.toString() });

    return null;
  }

  const previous = await prisma.membershipApplication.findFirst({
    where: { user_id: existing.id, status: ApplicationStatus.REJECTED, deletedAt: null },
    orderBy: { decided_at: 'desc' },
    select: { id: true },
  });

  // No closed application behind an INACTIVE, password-less account is a state
  // nothing in this codebase produces. Refused rather than guessed at.
  if (!previous) {
    logger.info('auth.reapplyNoClosedApplication', { userId: existing.id.toString() });

    return null;
  }

  return {
    user: { id: existing.id, email: existing.email },
    member: await memberRepo.findMemberByUserId(prisma, existing.id),
    previousApplicationId: previous.id,
  };
};

/**
 * Public registration — one transaction for identity + application, KYC files
 * stored after the application row exists (spec §5 step 1).
 *
 * Also the re-application path (D-19): the same form, submitted by someone whose
 * previous application was finally rejected. It reuses their `Users` and
 * `Members` rows — the email is unique and citext, so a second account is not
 * merely undesirable but impossible — and creates a second
 * `MembershipApplication` beside the closed one. Both stay on record; the
 * association can see that this company was refused once and tried again, which
 * is exactly the context a reviewer wants and exactly what a fresh account would
 * have destroyed.
 */
export interface RegisterResult {
  /**
   * Where the confirmation screen can send the applicant immediately, without
   * waiting on the email — the same link `application.submitted` queues them
   * (`issueApplicationAccessToken`, below). NULL only on the duplicate-email
   * race swallowed below, where nothing was actually created for this caller.
   */
  trackUrl: string | null;
}

export const register = async (
  input: RegisterInput,
  files: RegistrationFile[],
  context: RequestContext,
): Promise<RegisterResult> => {
  captcha.assertCaptcha(input.captcha_token, input.captcha_answer);

  /*
    Every required face must be here.

    Read from the master, not from a constant: an admin who adds a required
    document type is asking for it from the next applicant onward, and an admin
    who marks one optional has stopped requiring it. Optional types are accepted
    if supplied and never demanded.
  */
  const checklist = await checklistFor('APPLICATION');

  for (const type of checklist.filter((item) => item.is_required)) {
    const supplied = files
      .filter((file) => file.code === type.code)
      .map((file) => sideForUpload(type.sides, file.side, file.declaredMime));

    for (const side of missingSides(type.sides, supplied)) {
      throw new AppError({
        errorType: ERROR_TYPES.VALIDATION_ERROR,
        // `document.required` ("{{documentType}} is required"), not
        // `document.fileRequired` ("Choose a file to upload") — the applicant is
        // being told WHICH document is missing, not that they forgot to pick one.
        messageKey: 'document.required',
        replacements: { documentType: describeSide(type.name, side) },
        details: { document: uploadFieldName(type.code, side) },
      });
    }
  }

  for (const file of files) {
    await documentService.validateApplicationFileBuffer(
      file.code,
      file.buffer,
      file.declaredMime,
      file.side,
    );
  }

  const existing = await authRepo.findUserByEmail(prisma, input.email);

  /**
   * The one account state that may submit this form twice.
   *
   * Every other existing account — active, awaiting approval, half-verified —
   * still falls through to the same silent success as before. The caller cannot
   * tell any of these apart, and cannot tell them from an address that has never
   * been seen: one response, one message, one status code (security.md §2).
   */
  let reapplicant: Reapplicant | null = null;

  if (existing) {
    reapplicant = await resolveReapplicant(existing);

    if (!reapplicant) {
      if (
        existing.status === UserStatus.ACTIVE ||
        existing.status === UserStatus.PENDING_APPROVAL ||
        existing.email_verified_at !== null
      ) {
        logger.info('auth.registerOnExistingAccount', {
          userId: existing.id.toString(),
          status: existing.status,
        });
        return { trackUrl: null };
      }

      if (existing.status === UserStatus.PENDING_VERIFICATION) {
        logger.info('auth.registerOnLegacyPendingAccount', {
          userId: existing.id.toString(),
        });
        return { trackUrl: null };
      }

      return { trackUrl: null };
    }

    logger.info('auth.reapplyAfterRejection', { userId: existing.id.toString() });
  }

  const phone = input.mobile;
  // Their own number is not "taken" by somebody else (D-19). Without the
  // exclusion a re-applicant would silently lose the mobile they registered with.
  const phoneClaimable = !(await authRepo.isPhoneTaken(prisma, phone, reapplicant?.user.id));

  if (!phoneClaimable) {
    logger.info('auth.registerPhoneAlreadyClaimed', {
      reason: 'phone_taken_account_created_without_it',
    });
  }

  const companyTypeId = BigInt(input.company_type_id);
  const countryId = BigInt(input.country_id);
  const stateId = BigInt(input.state_id);
  const cityId = input.city_id ? BigInt(input.city_id) : null;
  const categoryIds = input.category_ids.map((id) => BigInt(id));
  const primaryCategoryId = categoryIds[0]!;

  /*
    The chosen plan, checked before anything is written.

    An id that names a retired or deleted price is refused here rather than
    stored and discovered at approval — the applicant is in front of us now, and
    a price that has since been withdrawn is a different figure from the one
    they were shown. Only a live, category-free "new membership" price qualifies,
    which is exactly the set the membership page offers.
  */
  let feeStructureId: bigint | null = null;

  if (input.fee_structure_id) {
    const chosen = BigInt(input.fee_structure_id);
    const now = new Date();
    const plan = await prisma.feeStructure.findFirst({
      where: {
        id: chosen,
        deletedAt: null,
        is_active: true,
        fee_type: 'NEW_MEMBERSHIP',
        category_id: null,
        tier_id: null,
        effective_from: { lte: now },
        OR: [{ effective_to: null }, { effective_to: { gte: now } }],
      },
      select: { id: true },
    });

    if (!plan) throw conflict('masters.noFeeConfigured');

    feeStructureId = plan.id;
  }

  const [companyType, country, state, city, categories] = await Promise.all([
    prisma.companyType.findFirst({
      where: { id: companyTypeId, deletedAt: null, is_active: true },
    }),
    prisma.country.findFirst({ where: { id: countryId, deletedAt: null, is_active: true } }),
    prisma.state.findFirst({
      where: { id: stateId, country_id: countryId, deletedAt: null, is_active: true },
    }),
    cityId
      ? prisma.city.findFirst({
          where: { id: cityId, state_id: stateId, deletedAt: null, is_active: true },
        })
      : Promise.resolve(null),
    prisma.membershipCategory.findMany({
      where: { id: { in: categoryIds }, deletedAt: null, is_active: true },
    }),
  ]);

  if (!companyType) {
    throw new AppError({
      errorType: ERROR_TYPES.NOT_FOUND,
      messageKey: 'masters.companyTypeNotFound',
    });
  }
  if (!country) {
    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'masters.countryNotFound' });
  }
  if (!state) {
    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'masters.stateNotFound' });
  }
  if (cityId && !city) {
    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'masters.cityNotFound' });
  }
  if (categories.length !== categoryIds.length) {
    throw new AppError({
      errorType: ERROR_TYPES.NOT_FOUND,
      messageKey: 'masters.categoryNotFound',
    });
  }

  const workflow = await appRepo.findActiveWorkflow(
    prisma,
    ApprovalSubjectType.MEMBERSHIP_APPLICATION,
  );
  if (!workflow || workflow.stages.length === 0) {
    throw conflict('application.workflowHasNoStages');
  }

  const firstStage = engine.stageForResubmission(workflow.stages);
  const gstNumber = input.gstin_holder ? (input.gst_number ?? null) : null;
  const storedKeys: string[] = [];

  try {
    const trackUrl = await prisma.$transaction(async (tx) => {
      /*
        The snapshot every applicant supplies, new or returning.

        Written once and applied either to fresh rows or over the existing ones,
        so a re-application cannot drift into carrying a different set of fields
        from a first application. Whatever the form says now is what the record
        says now — the previous attempt's values live on in the closed
        application's own snapshot, which is where the audit trail wants them.
      */
      const memberSnapshot = {
        gstin_holder: input.gstin_holder,
        company_category: input.company_category ?? null,
        landline: input.landline ?? null,
        consent_accepted_at: new Date(),
        consent_ip: context.ip,
        company_name: input.company_name,
        pan_number: input.pan_number,
        gst_number: gstNumber,
      };

      const addressSnapshot = {
        address_type: AddressType.REGISTERED,
        line1: input.address_line1,
        line2: input.address_line2 ?? null,
        city: city?.name ?? state.name,
        state: state.name,
        country: country.name,
        pincode: input.pincode,
        is_primary: true,
      };

      /*
        Reuse or create — never both, and never a second account.

        `Users.email` is citext and unique among live rows, so a returning
        applicant CANNOT be given a new login even if we wanted to: the insert
        would violate the index. Reuse is therefore not an optimisation, it is
        the only correct shape. `PENDING_APPROVAL` goes back on because that is
        what "an application is in flight" means for a login with no password,
        and it is what the approval path expects to find when it activates them.
      */
      const user = reapplicant
        ? await authRepo.updateUser(tx, reapplicant.user.id, {
            full_name: input.company_name,
            ...(phoneClaimable ? { phone } : {}),
            status: UserStatus.PENDING_APPROVAL,
          })
        : await authRepo.createUser(tx, {
            email: input.email,
            full_name: input.company_name,
            phone: phoneClaimable ? phone : null,
            password_hash: null,
            status: UserStatus.PENDING_APPROVAL,
          });

      /*
        `Members.primary_user_id` is unique, so one login owns exactly one company
        record for its whole life. A re-application updates that record in place;
        it stays `DRAFT`, because nothing has been approved and the directory must
        not see it.
      */
      const member = reapplicant?.member
        ? await memberRepo.updateMember(tx, reapplicant.member.id, {
            ...memberSnapshot,
            company_type: { connect: { id: companyTypeId } },
          })
        : await memberRepo.createMember(tx, {
            primary_user_id: user.id,
            company_type_id: companyTypeId,
            ...memberSnapshot,
            status: MemberStatus.DRAFT,
          });

      await memberRepo.setMemberCategories(tx, member.id, categoryIds);

      /*
        One registered address per member, updated rather than accumulated.

        `MemberAddresses_one_primary_per_member` is a partial unique index, so a
        second primary address is a constraint violation rather than a mess to
        clean up later. Updating the row the applicant already has keeps its id
        stable for anything referencing it.
      */
      const existingAddress = reapplicant?.member
        ? await tx.memberAddress.findFirst({
            where: {
              member_id: member.id,
              address_type: AddressType.REGISTERED,
              deletedAt: null,
            },
            orderBy: [{ is_primary: 'desc' }, { id: 'asc' }],
            select: { id: true },
          })
        : null;

      /*
        The location FKs are named at each call site rather than carried in the
        snapshot above.

        Prisma types a CREATE and an UPDATE differently where a relation exists:
        the create takes the scalar `country_id`, the update takes
        `country_ref: { connect }`, and the same column cannot be written both
        ways. Spreading one shared object into both would compile — a spread
        variable escapes TypeScript's excess-property check — and then fail at
        runtime with "Unknown argument". Naming them here keeps the compiler in a
        position to notice.
      */
      if (existingAddress) {
        // Demote anything else claiming primary first. The applicant's own
        // registered address is the one we are about to set, and the partial
        // unique index allows exactly one.
        await memberRepo.clearPrimaryAddresses(tx, member.id, existingAddress.id);

        await memberRepo.updateAddress(tx, existingAddress.id, {
          ...addressSnapshot,
          country_ref: { connect: { id: countryId } },
          state_ref: { connect: { id: stateId } },
          city_ref: cityId ? { connect: { id: cityId } } : { disconnect: true },
        });
      } else {
        await tx.memberAddress.create({
          data: {
            member_id: member.id,
            ...addressSnapshot,
            country_id: countryId,
            state_id: stateId,
            city_id: cityId,
          },
        });
      }

      const applicationNumber = await allocateApplicationNumber(tx);

      const application = await appRepo.createApplication(tx, {
        user_id: user.id,
        member_id: member.id,
        category_id: primaryCategoryId,
        tier_id: null,
        fee_structure_id: feeStructureId,
        company_name: input.company_name,
        legal_name: null,
        business_type: null,
        iec_code: null,
        gst_number: gstNumber,
        pan_number: input.pan_number,
        trade_license_no: null,
        website: null,
        about: null,
        status: ApplicationStatus.SUBMITTED,
        application_number: applicationNumber,
        submitted_at: new Date(),
        current_stage_id: firstStage.id,
      });

      await appRepo.createApprovalRequest(tx, {
        workflow_id: workflow.id,
        subject_type: ApprovalSubjectType.MEMBERSHIP_APPLICATION,
        application_id: application.id,
        current_stage_id: firstStage.id,
        status: ApprovalRequestStatus.OPEN,
      });

      const actor = {
        id: user.id,
        ip: context.ip,
        userAgent: context.userAgent,
        requestId: context.requestId,
      };

      for (const file of files) {
        const stored = await documentService.storeApplicationFile({
          applicationId: application.id,
          documentTypeCode: file.code,
          originalName: file.originalName,
          buffer: file.buffer,
          declaredMime: file.declaredMime,
          requestedSide: file.side,
        });
        storedKeys.push(stored.file_path);

        await documentService.createApplicationDocumentRow(tx, {
          applicationId: application.id,
          stored,
          actor,
        });
      }

      /*
        The applicant's only way back to this application.

        Issued at submission rather than at the first rejection (spec §6 item 7)
        for two reasons. The confirmation email has something to point at — "track
        or update it here" (spec §5) — instead of asking someone with no account
        to sign in. And when the reviewer does send it back, the link in the
        rejection email is the same one already in the applicant's inbox rather
        than a second URL to tell apart from the first.

        Inside the registration transaction, so a link is never emailed for an
        application that rolled back.
      */
      const accessLink = await issueApplicationAccessToken(tx, application.id);

      await queueNotifications(tx, ['EMAIL', 'IN_APP'], {
        templateCode: 'application.submitted',
        userId: user.id,
        memberId: member.id,
        toAddress: user.email,
        payload: {
          company_name: input.company_name,
          application_number: applicationNumber,
          stage_name: firstStage.name,
          track_url: accessLink.url,
        },
      });

      /*
        Two different events, told apart on purpose.

        A first registration created an account; a re-application did not, and an
        audit trail that says `user.signed_up` twice for one login describes
        something that never happened. `application.reapplied` carries the closed
        application's id, so the pair reads as one story: refused here, tried
        again there, same person throughout.
      */
      if (reapplicant) {
        await writeAudit(tx, {
          action: AUDIT_ACTIONS.APPLICATION_REAPPLIED,
          entityName: 'MembershipApplications',
          entityId: application.id,
          actorType: ACTOR_TYPES.MEMBER,
          actorId: user.id,
          before: {
            user_status: UserStatus.INACTIVE,
            previous_application_id: reapplicant.previousApplicationId?.toString() ?? null,
          },
          after: {
            company_name: input.company_name,
            user_status: UserStatus.PENDING_APPROVAL,
            application_number: applicationNumber,
          },
          ip: context.ip,
          userAgent: context.userAgent,
          requestId: context.requestId,
        });
      } else {
        await writeAudit(tx, {
          action: AUDIT_ACTIONS.USER_SIGNED_UP,
          entityName: 'Users',
          entityId: user.id,
          actorType: ACTOR_TYPES.MEMBER,
          actorId: user.id,
          after: {
            email: user.email,
            company_name: input.company_name,
            status: user.status,
            application_id: application.id.toString(),
          },
          ip: context.ip,
          userAgent: context.userAgent,
          requestId: context.requestId,
        });
      }

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.APPLICATION_SUBMITTED,
        entityName: 'MembershipApplications',
        entityId: application.id,
        actorType: ACTOR_TYPES.MEMBER,
        actorId: user.id,
        before: { status: ApplicationStatus.DRAFT },
        after: {
          status: ApplicationStatus.SUBMITTED,
          application_number: applicationNumber,
          resubmission: false,
        },
        ip: context.ip,
        userAgent: context.userAgent,
        requestId: context.requestId,
      });

      return accessLink.url;
    });

    return { trackUrl };
  } catch (error) {
    await cleanupStoredFiles(storedKeys);

    if (isUniqueViolation(error, 'gst_number')) throw conflict('member.gstAlreadyRegistered');
    if (isUniqueViolation(error, 'email')) {
      logger.info('auth.registerRaceOnEmail', {});
      return { trackUrl: null };
    }

    throw error;
  }
};
