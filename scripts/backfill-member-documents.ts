/**
 * Move approved applications' KYC onto the member records that were activated
 * before `adoptApplicationDocuments` existed.
 *
 * Those members show "No documents uploaded" on a record whose documents an
 * admin demonstrably verified — the files were never copied off the application.
 * This is the same copy the approval now performs, run over the backlog.
 *
 * Safe to re-run: the copy skips a (type, side) the member already holds, so a
 * second pass over the same member writes nothing and copies no bytes.
 *
 *   npx tsx scripts/backfill-member-documents.ts [--dry-run]
 */
import { ApplicationStatus, PrismaClient } from '@prisma/client';
import { adoptApplicationDocuments } from '../src/modules/application/activation.service';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');

const main = async (): Promise<void> => {
  const approved = await prisma.membershipApplication.findMany({
    where: { status: ApplicationStatus.APPROVED, deletedAt: null },
    orderBy: { id: 'asc' },
  });

  console.log(`${approved.length} approved application(s) to check${dryRun ? ' (dry run)' : ''}`);

  let members = 0;
  let files = 0;

  for (const application of approved) {
    // One transaction per member, not one for the whole backlog: a failure on
    // application 40 must not roll back the 39 that already copied cleanly.
    const result = await prisma.$transaction(async (tx) => {
      const held = await tx.memberDocument.count({
        where: { member_id: application.member_id, deletedAt: null },
      });

      if (dryRun) {
        const available = await tx.applicationDocument.count({
          where: { application_id: application.id, deletedAt: null },
        });

        return { copied: held === 0 ? available : 0 };
      }

      return adoptApplicationDocuments(tx, application, application.member_id);
    });

    if (result.copied > 0) {
      members += 1;
      files += result.copied;
      console.log(
        `  member ${application.member_id} (${application.application_number ?? application.id}) — ${result.copied} document(s)`,
      );
    }
  }

  console.log(
    dryRun
      ? `Would copy ${files} document(s) across ${members} member(s).`
      : `Copied ${files} document(s) across ${members} member(s).`,
  );
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
