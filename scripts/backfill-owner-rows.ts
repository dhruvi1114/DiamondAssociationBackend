/**
 * Give every member's owner login BOTH rows it should have had since signup:
 * the ACTIVE `MemberUsers` team row, and the `MemberContacts` row that names
 * the person behind the login.
 *
 * `findMemberByUserId` (member.repository.ts) resolves a login to its company
 * through `MemberUsers`, requiring an ACTIVE row. `register.service.ts`
 * created the `Members` row without ever creating that row, so the owner's
 * own login could not find their company: `getOrCreateOwnMember` saw no
 * member, tried to provision a new one, hit `Members.primary_user_id`'s
 * unique index because the company already existed, and its recovery path ran
 * the same blind lookup a second time — still null. The Profile screen showed
 * a 500.
 *
 * The same registration path also never wrote the owner's `MemberContacts`
 * row — the row `provisionMember` (member.service.ts) creates whenever it
 * provisions a member the other way. Without it the Contacts tab shows no
 * one, because there is no one to show: the row that would name the owner as
 * a person, rather than only as a login, was never written.
 *
 * `register.service.ts` now creates both rows going forward
 * (`ensureOwnerTeamRow` / `ensureOwnerContact`, member.repository.ts); this
 * script repairs the members created before that fix. It calls those same
 * two helpers rather than reimplementing their "already has one" checks, so
 * this script and the registration path can never drift apart on what
 * "already has one" means.
 *
 * Safe to re-run: both helpers no-op once the row they create exists, so a
 * second pass over an already-repaired member finds nothing to report and
 * writes nothing.
 *
 *   npx tsx scripts/backfill-owner-rows.ts [--dry-run]
 */
import { PrismaClient } from '@prisma/client';
import { ensureOwnerContact, ensureOwnerTeamRow } from '../src/modules/member/member.repository';
import { MEMBER_USER_STATUS } from '../src/modules/member/team.constants';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');

const main = async (): Promise<void> => {
  // Every non-deleted member, with just enough of the team-row and contact
  // lists to tell — per member, for its OWN primary_user_id — whether either
  // is missing. Not a substitute for `ensureOwnerTeamRow` / `ensureOwnerContact`'s
  // own checks (those still gate every write below); this is only what the
  // report line and the dry run need to say.
  const members = await prisma.member.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      company_name: true,
      primary_user_id: true,
      primary_user: { select: { full_name: true, email: true, phone: true } },
      team_users: { select: { user_id: true, status: true } },
      contacts: { where: { deletedAt: null }, select: { user_id: true } },
    },
    orderBy: { id: 'asc' },
  });

  const rows = members.map((member) => ({
    member,
    missingTeamRow: !member.team_users.some(
      (row) => row.user_id === member.primary_user_id && row.status === MEMBER_USER_STATUS.ACTIVE,
    ),
    missingContact: !member.contacts.some((row) => row.user_id === member.primary_user_id),
  }));

  const missingTeamRow = rows.filter((row) => row.missingTeamRow);
  const missingContact = rows.filter((row) => row.missingContact);

  console.log(
    `${missingContact.length} member(s) missing an owner contact row, ` +
      `${missingTeamRow.length} missing an owner team row${dryRun ? ' (dry run)' : ''}`,
  );

  // Member id and company name so a human can find the row; user id so it
  // can be cross-checked against the login. No email — personal data stays
  // out of script output.
  for (const { member, missingTeamRow: needsTeamRow, missingContact: needsContact } of rows) {
    if (!needsTeamRow && !needsContact) continue;

    const missing = [needsTeamRow && 'team row', needsContact && 'contact row']
      .filter(Boolean)
      .join(', ');

    console.log(
      `  member ${member.id} (${member.company_name}) — user ${member.primary_user_id} — missing: ${missing}`,
    );
  }

  if (!dryRun) {
    for (const { member } of rows) {
      // Both helpers re-check before writing, so calling them on every
      // member — not only the ones flagged missing above — stays safe even
      // if that snapshot is stale by the time this runs.
      await ensureOwnerTeamRow(prisma, {
        member_id: member.id,
        user_id: member.primary_user_id,
      });

      await ensureOwnerContact(prisma, {
        member_id: member.id,
        user_id: member.primary_user_id,
        name: member.primary_user.full_name,
        email: member.primary_user.email,
        phone: member.primary_user.phone,
      });
    }
  }

  console.log(
    dryRun
      ? `Would create ${missingTeamRow.length} team row(s) and ${missingContact.length} contact row(s).`
      : `Created ${missingTeamRow.length} team row(s) and ${missingContact.length} contact row(s).`,
  );
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
