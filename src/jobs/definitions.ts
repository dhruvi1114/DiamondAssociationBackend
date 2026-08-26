import { JobRunStatus, NotificationStatus, Prisma } from '@prisma/client';
import { prisma } from '@db/prisma';
import { logger } from '@logger/logger';
import { releaseExpiredHolds, remindersDue } from '@modules/event/expiry.service';
import { drainNotifications } from '@notifications/drain';
import type { JobDefinition } from '@jobs/runner';

/** observability.md §7 retention. */
const JOB_RUN_RETENTION_DAYS = 90;
const SENT_NOTIFICATION_RETENTION_DAYS = 180;
/** A run still RUNNING after this long means the process died mid-job. */
const STUCK_RUN_MINUTES = 60;
/** A row stuck SENDING for this long was claimed by a process that then died. */
const STUCK_SENDING_MINUTES = 15;

const daysAgo = (days: number): Date => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * 60 * 1000);

/**
 * Drain the notification outbox (ADR-010).
 *
 * Every minute rather than on a timer inside the request: a member who signs up
 * waits at most 60 seconds for their OTP, and no business transaction ever
 * waits on SMTP.
 */
export const notificationDrainJob: JobDefinition = {
  name: 'notification.drain',
  schedule: '* * * * *',
  description: 'Dispatches queued notifications, retrying with exponential backoff.',
  handler: async () => {
    // Recover rows abandoned mid-flight by a process that died after claiming
    // them. Without this they would sit in SENDING forever, invisible to the
    // drain and reported to nobody.
    await prisma.notification.updateMany({
      where: {
        status: NotificationStatus.SENDING,
        updatedAt: { lt: minutesAgo(STUCK_SENDING_MINUTES) },
      },
      data: { status: NotificationStatus.QUEUED, next_attempt_at: new Date() },
    });

    const result = await drainNotifications();

    return result.claimed;
  },
};

/**
 * Prune expired auth material (rbac.md §1).
 *
 * M0 owns the schedule; `AuthTokens`, `OtpCodes` and `PasswordResetTokens`
 * arrive in M1, so today this job only closes out stale job rows. The point of
 * shipping it now is that M1 adds delete statements to an existing, already
 * monitored job instead of introducing a new one.
 */
export const tokenPruneJob: JobDefinition = {
  name: 'auth.prune_expired',
  schedule: '15 3 * * *',
  description: 'Removes expired tokens and OTP codes, and closes out abandoned job runs.',
  handler: async () => {
    const stuck = await prisma.jobRun.updateMany({
      where: { status: JobRunStatus.RUNNING, started_at: { lt: minutesAgo(STUCK_RUN_MINUTES) } },
      data: {
        status: JobRunStatus.FAILED,
        finished_at: new Date(),
        error: 'Run never finished — the process most likely restarted mid-job.',
      },
    });

    return stuck.count;
  },
};

/**
 * Enforce retention on operational tables (observability.md §7).
 *
 * SENT notifications age out at 180 days; FAILED ones are kept indefinitely
 * until somebody has acknowledged them, because an unacknowledged failure is
 * the whole reason the outbox is observable.
 */
export const retentionPruneJob: JobDefinition = {
  name: 'system.prune_retention',
  schedule: '45 3 * * *',
  description: 'Deletes JobRuns older than 90 days and SENT notifications older than 180 days.',
  handler: async () => {
    const [jobRuns, notifications] = await prisma.$transaction([
      prisma.jobRun.deleteMany({
        where: {
          started_at: { lt: daysAgo(JOB_RUN_RETENTION_DAYS) },
          status: { not: JobRunStatus.RUNNING },
        },
      }),
      prisma.notification.deleteMany({
        where: {
          status: NotificationStatus.SENT,
          sent_at: { lt: daysAgo(SENT_NOTIFICATION_RETENTION_DAYS) },
        },
      }),
    ]);

    return jobRuns.count + notifications.count;
  },
};

/**
 * Release event holds nobody paid for, and warn the ones still in time.
 *
 * Hourly rather than nightly. A hold that expires at 09:00 is a seat somebody
 * else could be buying at 09:05, and on a nearly-full event a nightly sweep
 * would leave it unsellable for the rest of the day.
 *
 * Both halves live in one job because they ask the same question of the same
 * rows — how long has this hold been waiting? Two jobs would let the reminder
 * schedule and the release deadline drift apart, which is the very thing
 * deriving the reminders from the hold length prevents.
 */
export const eventHoldSweepJob: JobDefinition = {
  name: 'event.hold_sweep',
  schedule: '5 * * * *',
  description:
    'Releases event seats held by unpaid bookings past their deadline, and flags bookings due a payment reminder.',
  handler: async () => {
    const released = await releaseExpiredHolds();
    const reminders = await remindersDue();

    if (reminders.length > 0) {
      logger.info('event.remindersDue', {
        count: reminders.length,
        codes: reminders.map((row) => row.registration_code),
      });
    }

    return released + reminders.length;
  },
};

export const jobDefinitions: JobDefinition[] = [
  notificationDrainJob,
  tokenPruneJob,
  retentionPruneJob,
  eventHoldSweepJob,
];

/**
 * "Have the jobs stopped?" in one query — the dashboard tile in
 * observability.md §6. Exposed here so M10 reads it from the job module rather
 * than reinventing the SQL.
 */
export const latestJobRuns = () =>
  prisma.$queryRaw<
    { job_name: string; started_at: Date; status: JobRunStatus; processed_count: number }[]
  >(Prisma.sql`
    SELECT DISTINCT ON ("job_name")
           "job_name", "started_at", "status", "processed_count"
    FROM "JobRuns"
    ORDER BY "job_name", "started_at" DESC
  `);
