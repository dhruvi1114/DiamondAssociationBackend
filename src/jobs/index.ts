import cron, { type ScheduledTask } from 'node-cron';
import { environment } from '@config/config';
import { logger } from '@logger/logger';
import { jobDefinitions } from '@jobs/definitions';
import { runJob } from '@jobs/runner';

export * from './runner';
export * from './definitions';

const tasks: ScheduledTask[] = [];

/**
 * In-process cron (ADR-009), gated on `ENABLE_JOBS`.
 *
 * The flag exists because the scheduler lives inside the API process: if the
 * API is ever scaled horizontally, exactly one instance may carry the flag,
 * otherwise every instance drains the same outbox. Extraction to a dedicated
 * worker is the post-MVP option, and the flag is what makes that a deployment
 * change rather than a code change.
 */
export const startJobs = (): void => {
  if (!environment.enableJobs) {
    logger.info('jobs.disabled', { reason: 'ENABLE_JOBS is false on this instance' });
    return;
  }

  for (const job of jobDefinitions) {
    if (!cron.validate(job.schedule)) {
      logger.error('jobs.invalidSchedule', { jobName: job.name, schedule: job.schedule });
      continue;
    }

    const task = cron.schedule(
      job.schedule,
      () => {
        // runJob never rejects: it records FAILED and returns. An unhandled
        // rejection here would take the API process down with the job.
        void runJob(job);
      },
      { scheduled: true, timezone: 'UTC' },
    );

    tasks.push(task);

    logger.info('jobs.scheduled', { jobName: job.name, schedule: job.schedule });
  }
};

export const stopJobs = (): void => {
  tasks.forEach((task) => task.stop());
  tasks.length = 0;
};
