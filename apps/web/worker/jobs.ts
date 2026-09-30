import type { JobQueue, QueueDefinition } from '@sold/core/jobs';
import { maintainOutboxPartitions, type FeatureFlags, type PrimaryDb } from '@sold/db';

/** Queues declared by Base. Extensions declare theirs through the SDK (Phase 1). */
export const baseQueues: QueueDefinition[] = [{ name: 'maintenance.partitions', class: 'bulk' }];

export interface JobDeps {
  db: PrimaryDb;
  flags: FeatureFlags;
  log: {
    info(o: object, m?: string): void;
    warn(o: object, m?: string): void;
    error(o: object, m?: string): void;
  };
}

/**
 * Wraps a non-essential job so it is deferred while the degradation-ladder rung
 * `degrade.pause-non-essential-jobs` is on (Section 8A.6). Returns true when the job should be skipped.
 */
export async function pausedByLadder(
  { flags, log }: Pick<JobDeps, 'flags' | 'log'>,
  job: string,
): Promise<boolean> {
  if (await flags.isEnabled('degrade.pause-non-essential-jobs')) {
    log.warn({ job }, 'job skipped: degradation ladder has paused non-essential jobs');
    return true;
  }
  return false;
}

export async function registerBaseJobs(queue: JobQueue, deps: JobDeps): Promise<void> {
  for (const def of baseQueues) await queue.ensureQueue(def);

  await queue.work('maintenance.partitions', async () => {
    if (await pausedByLadder(deps, 'maintenance.partitions')) return;
    const result = await maintainOutboxPartitions(deps.db);
    if (result.blocked)
      deps.log.error(
        result,
        'outbox retention blocked: unpublished events older than the retention window',
      );
    else deps.log.info(result, 'partition maintenance');
  });
  // Daily at 02:10 UTC, plus on every worker start (idempotent) so a fresh environment is never without partitions.
  await queue.schedule('maintenance.partitions', '10 2 * * *');
  await queue.enqueue(
    'maintenance.partitions',
    {},
    { idempotencyKey: `boot-${new Date().toISOString().slice(0, 10)}` },
  );
}
