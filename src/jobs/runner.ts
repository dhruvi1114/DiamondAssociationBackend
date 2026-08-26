import { JobRunStatus } from '@prisma/client';
import { prisma } from '@db/prisma';
import { logger } from '@logger/logger';
import { runWithRequestContext } from '@logger/requestContext';
import { ACTOR_TYPES } from '@constant/audit.constant';
import { uuidv4 } from '@helpers/random';

export interface JobDefinition {
  /** Registered identifier, written to `JobRuns.job_name`. */
  name: string;
  /** Standard 5-field cron expression. */
  schedule: string;
  /** Returns how many items it handled — the number recorded on the run row. */
  handler: () => Promise<number>;
  /** Human sentence for the job list in the admin dashboard (M10). */
  description: string;
}

/**
 * Run one job and record it in `JobRuns` (observability.md §1).
 *
 * A run row exists whatever happens, because the question the table answers is
 * "did the scheduled work run?" — and a job that threw before writing anything
 * is indistinguishable from a job that never fired. The row is written RUNNING
 * first and finalised exactly once, so a row still RUNNING long after its
 * schedule means the process died mid-job.
 *
 * Failure is contained: a throwing job marks its own run FAILED and does not
 * propagate, because node-cron would otherwise turn it into an unhandled
 * rejection and take the API process down with it.
 */
export const runJob = async (job: JobDefinition): Promise<void> => {
  const run = await prisma.jobRun.create({
    data: { job_name: job.name, status: JobRunStatus.RUNNING },
    select: { id: true },
  });

  await runWithRequestContext(
    { requestId: `job-${uuidv4()}`, actorType: ACTOR_TYPES.SYSTEM },
    async () => {
      const startedAt = Date.now();

      try {
        const processed = await job.handler();

        await prisma.jobRun.update({
          where: { id: run.id },
          data: {
            status: JobRunStatus.SUCCESS,
            finished_at: new Date(),
            processed_count: processed,
          },
        });

        logger.info('job.completed', {
          jobName: job.name,
          processed,
          durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);

        await prisma.jobRun
          .update({
            where: { id: run.id },
            data: {
              status: JobRunStatus.FAILED,
              finished_at: new Date(),
              error: detail.slice(0, 1000),
            },
          })
          .catch(() => undefined);

        logger.error('job.failed', {
          jobName: job.name,
          durationMs: Date.now() - startedAt,
          detail,
        });
      }
    },
  );
};
