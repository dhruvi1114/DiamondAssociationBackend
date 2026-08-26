/* eslint-disable no-console */
import path from 'node:path';
import { ApplicationStatus } from '@prisma/client';
import { loadEnvironmentFiles } from '../src/config/loadEnv';
import { prisma } from '../src/db/prisma';
import { hasLiveApplicationAccessToken } from '../src/modules/application/application.tokens';
import { reissueCorrectionLink } from '../src/modules/application/public.service';

/**
 * One-off: give the applications already stuck in `RETURNED_FOR_CORRECTION` a
 * way back in (reject-resubmit spec OQ-5).
 *
 * Before this flow existed, "returned" meant "sign in and fix it" — and the
 * account it told them to sign in to has no password and is refused at the login
 * screen by design (spec D-10). Every application in that status on the day this
 * ships is therefore a dead end: the association is waiting on the applicant,
 * the applicant has been told to do something they cannot do, and neither side
 * can tell. This script issues each of them a link and re-sends the rejection
 * email that should have carried one.
 *
 *   npm run backfill:resubmit-links -- --dry-run     # list, change nothing
 *   npm run backfill:resubmit-links                  # do it
 *   npm run backfill:resubmit-links -- --force       # re-issue even where a
 *                                                     link is already live
 *
 * Safe to run twice. Without `--force` an application that already has a working
 * link is skipped, so a half-finished run is resumed rather than repeated — and
 * nobody gets the same email twice because the first attempt timed out.
 *
 * One transaction per application, deliberately not one for the batch: a single
 * application that cannot be resolved (a workflow that was deleted, a user row
 * that was purged) should cost that application, not the other forty.
 */

/* Same loader `config.ts` runs for itself, called here too so the message about
   a missing `.env` comes from the loader rather than from a zod failure three
   modules down. Idempotent — a real environment variable always wins. */
loadEnvironmentFiles(path.join(__dirname, '..'));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');

const main = async (): Promise<void> => {
  const stranded = await prisma.membershipApplication.findMany({
    where: { status: ApplicationStatus.RETURNED_FOR_CORRECTION, deletedAt: null },
    orderBy: { updatedAt: 'asc' },
    select: {
      id: true,
      application_number: true,
      company_name: true,
      resubmission_count: true,
      updatedAt: true,
    },
  });

  if (stranded.length === 0) {
    console.log('Nothing to do — no application is waiting on a correction.');
    return;
  }

  console.log(
    `${stranded.length} application(s) in RETURNED_FOR_CORRECTION${dryRun ? ' (dry run)' : ''}:`,
  );

  let issued = 0;
  let skipped = 0;
  let failed = 0;

  for (const application of stranded) {
    const reference = application.application_number ?? `#${application.id.toString()}`;
    const label = `${reference} — ${application.company_name}`;

    const alreadyLinked = await hasLiveApplicationAccessToken(prisma, application.id);

    if (alreadyLinked && !force) {
      console.log(`  skip   ${label} (a link is already live)`);
      skipped += 1;
      continue;
    }

    if (dryRun) {
      console.log(`  would  ${label} (returned ${application.updatedAt.toISOString()})`);
      issued += 1;
      continue;
    }

    try {
      const result = await prisma.$transaction((tx) =>
        reissueCorrectionLink(tx, application.id, {
          reason: 'backfill_oq5_stranded_returned_application',
          actorType: 'SYSTEM',
          context: { ip: null, userAgent: null, requestId: null },
        }),
      );

      if (!result) {
        // Its status changed between the read and the write — somebody decided
        // it while this was running. Not an error, just no longer our business.
        console.log(`  skip   ${label} (no longer awaiting a correction)`);
        skipped += 1;
        continue;
      }

      // The URL is NOT printed. It is a credential, and a deploy log is not the
      // place for one (observability.md §3).
      console.log(`  sent   ${label}`);
      issued += 1;
    } catch (error) {
      console.error(`  FAILED ${label}: ${error instanceof Error ? error.message : String(error)}`);
      failed += 1;
    }
  }

  console.log(
    `\n${dryRun ? 'Would issue' : 'Issued'}: ${issued} · skipped: ${skipped} · failed: ${failed}`,
  );

  if (!dryRun && issued > 0) {
    console.log(
      'Emails are queued in the outbox; the drain job sends them within a minute (ADR-010).',
    );
  }

  if (failed > 0) {
    process.exitCode = 1;
  }
};

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
