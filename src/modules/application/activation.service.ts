import {
  InvoiceStatus,
  InvoiceType,
  MemberStatus,
  Prisma,
  TermStatus,
  TermType,
  type MembershipApplication,
} from '@prisma/client';
import { AUDIT_ACTIONS } from '@constant/audit.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { allocateInvoiceNumber, generateDocumentNumber } from '@helpers/documentNumber';
import { buildStorageKey, storage } from '@helpers/storage';
import { writeAudit } from '@helpers/audit';
import {
  getBooleanSetting,
  getNumericSetting,
  getSetting,
  SETTING_KEYS,
  type RenewalBasis,
} from '@helpers/settings';
import { planTerm } from '@helpers/membershipTerm';
import { queueNotifications } from '@notifications/outbox';
import { revokeApplicationAccessTokens } from '@modules/application/application.tokens';
import * as authService from '@modules/auth/auth.service';
import * as masters from '@modules/masters/masters.service';
import * as memberRepo from '@modules/member/member.repository';
import { AppError } from '@utils/appError';

/**
 * What happens the moment an application is approved.
 *
 * This is the most consequential transaction in the platform. It turns a form
 * into a member: it issues a membership number, opens a term, prices that term
 * from the fee table and raises the invoice that must be paid before the
 * membership goes live.
 *
 * **All of it, or none of it.** A member with a code but no invoice would be
 * owed a membership nobody billed for; an invoice with no term would bill for
 * nothing. Every write below runs inside the caller's transaction, so a failure
 * anywhere rolls back the approval itself.
 */

interface Actor {
  id: bigint;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export interface ActivationResult {
  memberCode: string;
  termId: bigint;
  invoiceId: bigint;
  invoiceNumber: string;
  totalAmount: string;
  /** How many verified KYC files were moved onto the member record. */
  documentsAdopted: number;
}

/**
 * `LGDGF/2026/0042` — the membership number a company quotes for the rest of its
 * life with the federation. Allocated once, on approval, and never reissued.
 */
const allocateMemberCode = (tx: Prisma.TransactionClient): Promise<string> =>
  generateDocumentNumber(tx, {
    prefix: 'LGDGF',
    period: String(new Date().getUTCFullYear()),
    width: 4,
    separator: '/',
  });

/** `31 Mar 2027` — a date a member can read on an invoice line. */
const asDate = (on: Date): string =>
  on.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * The configured application fee, or a hard failure.
 *
 * Deliberately not a fallback-to-zero. The settings API only accepts a valid
 * amount, so an invalid one here means the row was changed outside the
 * application — and the safe response to "the association charges an
 * application fee but I cannot tell how much" is to stop the approval and say
 * so, not to issue an invoice that is silently short by the fee.
 */
const readApplicationFee = (raw: string | null): Prisma.Decimal => {
  const value = raw?.trim() ?? '';

  if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    throw new AppError({
      errorType: ERROR_TYPES.INVALID_REQUEST,
      messageKey: 'settings.invalidApplicationFee',
      details: { key: SETTING_KEYS.APPLICATION_FEE_AMOUNT },
    });
  }

  return new Prisma.Decimal(value);
};

/**
 * Move the application's verified KYC onto the member record.
 *
 * **Why this exists.** `MemberDocuments` is what every member-facing screen and
 * every renewal check reads. Until this ran, approval created the member, the
 * term and the invoice and left the documents behind on the application — so an
 * admin who had just verified three files saw "No documents uploaded" on the
 * record they had verified them for.
 *
 * **Why the bytes are copied, not the path shared.** Two rows pointing at one
 * object is a latent data-loss bug: `storage.delete` is a real `rm`, so removing
 * either document would take the file out from under the other. A few hundred KB
 * is cheaper than a member's KYC disappearing when an old application is tidied
 * up.
 *
 * **Only the newest version of each (type, side).** A superseded v1 is history
 * that belongs to the application it was rejected on; the member record wants
 * the file that was actually accepted. The verification status travels with it,
 * so a document verified at stage 1 does not need verifying again.
 *
 * A copy that fails does NOT fail the approval. The membership is the thing that
 * must be atomic; a missing document copy is visible, reportable and re-runnable
 * by the backfill script, whereas a member with a code but no invoice is not
 * recoverable from the outside.
 */
export const adoptApplicationDocuments = async (
  tx: Prisma.TransactionClient,
  application: MembershipApplication,
  memberId: bigint,
): Promise<{ copied: number; keys: string[] }> => {
  const rows = await tx.applicationDocument.findMany({
    where: { application_id: application.id, deletedAt: null },
    orderBy: [{ document_type_id: 'asc' }, { side: 'asc' }, { version: 'desc' }],
  });

  // Newest per (type, side); the list is already ordered so the first wins.
  const newest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const key = `${row.document_type_id}:${row.side}`;
    if (!newest.has(key)) newest.set(key, row);
  }

  const keys: string[] = [];
  let copied = 0;

  for (const row of newest.values()) {
    // Idempotent: a re-run (or a backfill over a member approved earlier) must
    // not stack duplicate rows.
    const already = await tx.memberDocument.findFirst({
      where: {
        member_id: memberId,
        document_type_id: row.document_type_id,
        side: row.side,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (already) continue;

    const destination = buildStorageKey(
      ['members', memberId.toString(), row.document_type_id.toString()],
      row.original_name,
    );

    const stored = await storage.current.put(
      destination,
      await storage.current.getStream(row.file_path),
      { mime: row.mime_type, size: Number(row.size_bytes) },
    );
    keys.push(stored.key);

    await tx.memberDocument.create({
      data: {
        member_id: memberId,
        document_type_id: row.document_type_id,
        side: row.side,
        file_path: stored.key,
        original_name: row.original_name,
        mime_type: row.mime_type,
        size_bytes: row.size_bytes,
        checksum_sha256: row.checksum_sha256,
        version: 1,
        // The reviewer's decision travels with the file. Re-verifying a document
        // the committee already accepted is work the approval already did.
        verification_status: row.verification_status,
        verified_by_admin_id: row.verified_by_admin_id,
        verified_at: row.verified_at,
        remarks: row.remarks,
      },
    });
    copied += 1;
  }

  return { copied, keys };
};

export const activateApprovedApplication = async (
  tx: Prisma.TransactionClient,
  application: MembershipApplication,
  actor: Actor,
): Promise<ActivationResult> => {
  /* --- 1. price it, before anything is written ---------------------------- */

  // Deliberately first. If no fee is configured the approval must fail loudly
  // and change nothing — a ₹0 invoice raised because the price list was empty is
  // far worse than a blocked approval that names the missing configuration
  // (billing-payment.md §2).
  const fee = await masters.resolveFee({
    categoryId: application.category_id,
    tierId: application.tier_id,
    feeType: 'NEW_MEMBERSHIP',
  });

  /* --- 2. the member becomes real ---------------------------------------- */

  const member = await tx.member.findFirst({
    where: { id: application.member_id, deletedAt: null },
  });
  if (!member) {
    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'member.notFound' });
  }

  // A member approved twice would consume a second code and raise a second
  // invoice. The approval path already guards the status, but this is the write
  // that would do the damage, so it checks too.
  const memberCode = member.member_code ?? (await allocateMemberCode(tx));

  /* --- 2b. the KYC follows the member ------------------------------------ */

  const adopted = await adoptApplicationDocuments(tx, application, member.id);

  /* --- 3. the term the invoice pays for ---------------------------------- */

  /*
    How the term is dated is configuration, not code (`billing.renewal_basis`).

    On `term` — the default, and what this did before the setting existed — the
    term runs the fee's own duration from today. On `financial_year` every term
    ends 31 March so the federation renews together, and a member joining
    part-way through the year is billed only for the months that are left.

    An unreadable value falls back to `term`: the wrong answer here re-dates a
    membership and re-prices an invoice, so the fallback has to be the behaviour
    that was already in place, never the newer one.
  */
  const basis = ((await getSetting(SETTING_KEYS.RENEWAL_BASIS)) ?? 'term') as RenewalBasis;
  const termWindow = planTerm({
    from: new Date(),
    durationMonths: fee.duration_months,
    basis,
  });

  const term = await tx.membershipTerm.create({
    data: {
      member_id: member.id,
      category_id: application.category_id,
      tier_id: application.tier_id,
      term_type: TermType.NEW,
      valid_from: termWindow.validFrom,
      valid_till: termWindow.validTill,
      status: TermStatus.PENDING_PAYMENT,
    },
  });

  /* --- 4. the invoice ----------------------------------------------------- */

  const issueDate = new Date();
  const dueDays = await getNumericSetting(SETTING_KEYS.INVOICE_DUE_DAYS, 15);
  const dueDate = new Date(issueDate);
  dueDate.setDate(dueDate.getDate() + dueDays);

  const taxRate = new Prisma.Decimal(fee.tax_rate);
  const taxOn = (net: Prisma.Decimal) => net.mul(taxRate).div(100).toDecimalPlaces(2);

  /*
    Pro-rata, when the term was cut short to land on the financial year end.

    Charged on the MONTHS remaining, not the days (user decision, 2026-08-21):
    joining on the 3rd and joining on the 27th of the same month both buy that
    month. Rounded to 2dp per line, because tax is taken per line and summed —
    rounding the invoice total instead disagrees with the lines by a paisa often
    enough to matter to whoever reconciles it.
  */
  const listPrice = new Prisma.Decimal(fee.amount);
  const membershipNet = termWindow.prorated
    ? listPrice.mul(termWindow.months).div(termWindow.durationMonths).toDecimalPlaces(2)
    : listPrice;
  const membershipTax = taxOn(membershipNet);

  /*
    The one-time application fee, if the association charges one.

    Raised HERE, at approval, on the same invoice as the membership — not when
    the form is submitted. An invoice needs a Member row and an applicant has
    none until they are approved, and money taken from someone who is then
    rejected has to be refunded. One invoice, two lines, no refund path.

    Configuration, so it fails the same way a missing fee does: if the switch is
    on and the amount is unreadable, the approval stops rather than quietly
    raising an invoice that is short by the fee. A value of 0 is not an error —
    it is an association that turned the switch on and has not priced it yet —
    but it does not earn a line of its own on the invoice.
  */
  const applicationFeeNet = (await getBooleanSetting(SETTING_KEYS.CHARGE_APPLICATION_FEE, false))
    ? readApplicationFee(await getSetting(SETTING_KEYS.APPLICATION_FEE_AMOUNT))
    : new Prisma.Decimal(0);
  // Taxed at the membership fee's rate: it is the same association supplying the
  // same service to the same member on the same invoice. If the two ever attract
  // different GST rates, the application fee needs its own rate setting.
  const applicationFeeTax = taxOn(applicationFeeNet);
  const chargesApplicationFee = applicationFeeNet.gt(0);

  const subtotal = membershipNet.add(applicationFeeNet);
  const taxAmount = membershipTax.add(applicationFeeTax);
  const total = subtotal.add(taxAmount);

  const termLabel = `${fee.category_name}${fee.tier_name ? ` — ${fee.tier_name}` : ''} membership`;
  const period = termWindow.prorated
    ? `${termWindow.months} months, pro-rata to ${asDate(termWindow.validTill)}`
    : `${termWindow.months} months`;

  const invoice = await tx.invoice.create({
    data: {
      invoice_number: await allocateInvoiceNumber(tx, issueDate),
      member_id: member.id,
      invoice_type: InvoiceType.MEMBERSHIP,
      // Issued, not draft: the member is told to pay it in the same breath as
      // being told they were approved.
      status: InvoiceStatus.ISSUED,
      issue_date: issueDate,
      due_date: dueDate,
      subtotal,
      tax_amount: taxAmount,
      total_amount: total,
      amount_paid: new Prisma.Decimal(0),
      balance_due: total,
      currency: fee.currency,
      items: {
        create: [
          // First, because it is what the member did first. A one-time charge
          // above a recurring one also reads as one-time without saying so.
          ...(chargesApplicationFee
            ? [
                {
                  description: 'Application fee (one-time)',
                  quantity: new Prisma.Decimal(1),
                  unit_price: applicationFeeNet,
                  tax_rate: taxRate,
                  tax_amount: applicationFeeTax,
                  line_total: applicationFeeNet.add(applicationFeeTax),
                  // No fee structure behind it — this price comes from
                  // SystemSettings, and the column is nullable for exactly this.
                  fee_structure_id: null,
                  sort_order: 0,
                },
              ]
            : []),
          {
            description: `${termLabel} (${period})`,
            quantity: new Prisma.Decimal(1),
            unit_price: membershipNet,
            tax_rate: taxRate,
            tax_amount: membershipTax,
            line_total: membershipNet.add(membershipTax),
            // The fee this line came from, so any invoice can be traced back to
            // the price that produced it.
            fee_structure_id: BigInt(fee.fee_structure_id),
            sort_order: chargesApplicationFee ? 1 : 0,
          },
        ],
      },
    },
  });

  await tx.membershipTerm.update({
    where: { id: term.id },
    data: { invoice_id: invoice.id },
  });

  /* --- 5. the member record catches up ------------------------------------ */

  await tx.member.update({
    where: { id: member.id },
    data: {
      member_code: memberCode,
      // The approved snapshot becomes the member's record. Without this, an
      // applicant who corrected their trading name during review would be
      // approved under one name and listed under another — and the identity
      // fields (GST, IEC) that the committee actually verified would never reach
      // the record the directory and invoices are built from.
      company_name: application.company_name,
      legal_name: application.legal_name,
      iec_code: application.iec_code,
      gst_number: application.gst_number,
      pan_number: application.pan_number,
      trade_license_no: application.trade_license_no,
      website: application.website,
      about: application.about,
      // PENDING, not ACTIVE. Approval grants membership; payment starts it
      // (billing-payment.md §4). M5's payment handler makes the final move.
      status: MemberStatus.PENDING,
      current_term_id: term.id,
    },
  });

  if (application.category_id !== null) {
    const existing = await memberRepo.listMemberCategories(tx, member.id);
    await memberRepo.setMemberCategories(tx, member.id, [
      ...new Set([application.category_id, ...existing.map((row) => row.category.id)]),
    ]);
  }

  await tx.memberStatusHistory.create({
    data: {
      member_id: member.id,
      from_status: member.status,
      to_status: MemberStatus.PENDING,
      reason: `Application ${application.application_number ?? application.id} approved`,
      changed_by_admin_id: actor.id,
    },
  });

  /* --- 6. tell them ------------------------------------------------------- */

  const loginUser = await tx.user.findFirst({
    where: { id: application.user_id, deletedAt: null },
    select: { id: true, email: true, full_name: true, password_hash: true },
  });

  // Queued inside the transaction (ADR-010). A dead mail server cannot roll back
  // an approval, and nothing is sent for an approval that rolls back.
  // Email and the in-app bell: the applicant may not be looking at either, so
  // the one that reaches them first wins.
  await queueNotifications(tx, ['EMAIL', 'IN_APP'], {
    templateCode: 'application.approved',
    userId: application.user_id,
    memberId: member.id,
    toAddress: loginUser?.email ?? null,
    payload: {
      company_name: member.company_name,
      member_code: memberCode,
      invoice_number: invoice.invoice_number,
      total_amount: total.toFixed(2),
      due_date: dueDate.toISOString().slice(0, 10),
    },
  });

  /*
    The set-password email. THIS IS THE ONLY PLACE IT MAY BE SENT (spec D-10).

    Registration creates the account with `password_hash = NULL` and
    `PENDING_APPROVAL`, and `auth.service.ts` refuses a sign-in for that status —
    deliberately, because there is nothing to sign in to until the association
    has said yes. Handing out a password link any earlier would create a
    credential for a membership that does not exist yet, and an applicant who
    could log into an empty portal and wonder what it was for.

    Only when there is no password already: a member approved on a second
    application must not have their working password quietly superseded by a
    link they did not ask for.
  */
  if (loginUser && loginUser.password_hash === null) {
    await authService.issueInitialPasswordLink(
      tx,
      { id: loginUser.id, email: loginUser.email, full_name: loginUser.full_name },
      actor,
    );
  }

  /*
    The correction link dies here (spec §6 item 7).

    It exists so a rejected applicant can get back in without an account. An
    approved one has an account — and a live link that still accepts document
    replacements against an application the committee has already decided is a
    way to change the evidence behind an approval after the fact.

    Inside the same transaction as the approval, so the link stops working at
    exactly the moment the approval becomes true, and stays working if the
    approval rolls back.
  */
  await revokeApplicationAccessTokens(tx, application.id);

  await writeAudit(tx, {
    actorType: 'ADMIN',
    actorId: actor.id,
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
    action: AUDIT_ACTIONS.MEMBER_ACTIVATED,
    entityName: 'Members',
    entityId: member.id,
    before: { status: member.status, member_code: member.member_code },
    after: {
      status: MemberStatus.PENDING,
      member_code: memberCode,
      term_id: term.id.toString(),
      invoice_number: invoice.invoice_number,
      total_amount: total.toFixed(2),
      documents_adopted: adopted.copied,
    },
  });

  return {
    memberCode,
    termId: term.id,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoice_number,
    totalAmount: total.toFixed(2),
    documentsAdopted: adopted.copied,
  };
};
