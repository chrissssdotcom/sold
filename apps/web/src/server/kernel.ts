import {
  createKernel,
  toKernelLogger,
  type GeneratedRegistry,
  type Kernel,
} from '@sold/core/extensions';
import type { JobQueue } from '@sold/core/jobs';
import { PgBossQueue } from '@sold/jobs';
import * as generated from '../../.generated/extensions';
import { getRuntime, type Runtime } from './runtime';

/**
 * The extension kernel for the web process. Created lazily on first use (so a store with zero extensions pays
 * nothing) and CACHED, including a failure: a bad extension configuration must be visible to readiness as
 * `unavailable` (so a broken release never takes traffic) rather than re-attempted on every request.
 *
 * What boot does:
 *  - resolves load order and validates everything (throws with every problem listed);
 *  - starts a producer-only queue client only if some extension declares observers or jobs;
 *  - verifies that extension migrations were applied by the release pipeline (`pnpm db:migrate`) and fails fast if not.
 */
export type KernelStatus =
  | { state: 'booting' }
  | { state: 'ready'; extensions: string[] }
  | { state: 'failed'; error: string };

interface Slot {
  promise: Promise<Kernel>;
  status: KernelStatus;
}
const holder = globalThis as unknown as { __soldKernel?: Slot };

const registry: GeneratedRegistry = generated as unknown as GeneratedRegistry;

/** A queue that must never be used: installed when no extension declares queues. */
const unusedQueue: JobQueue = {
  kind: 'unused',
  start: async () => undefined,
  stop: async () => undefined,
  ensureQueue: async () => {
    throw new Error('No extension declares queues');
  },
  enqueue: async () => {
    throw new Error('No extension declares queues');
  },
  work: async () => {
    throw new Error('No extension declares queues');
  },
  schedule: async () => {
    throw new Error('No extension declares queues');
  },
  health: async () => {
    throw new Error('No extension declares queues');
  },
};

async function boot(rt: Runtime, slot: Slot): Promise<Kernel> {
  const needsQueue = registry.candidates.some(
    (c) =>
      registry.entries.some((e) => e.enabled && e.name === c.manifest.name) &&
      (c.manifest.observers.length > 0 || c.manifest.jobs.length > 0),
  );
  const queue = needsQueue
    ? new PgBossQueue({
        connectionString: rt.env.DATABASE_MIGRATION_URL ?? rt.env.DATABASE_URL,
        role: 'producer',
        poolMax: 2,
        onError: (error) => rt.log.error({ err: error }, 'queue error'),
      })
    : unusedQueue;

  const kernel = createKernel({
    env: rt.env,
    log: toKernelLogger(rt.log),
    db: rt.db,
    queue,
    registry,
    onInterceptorMetric: (m) => {
      rt.metrics.interceptorCalls.inc({
        extension: m.extension,
        interceptor: m.interceptor,
        hook: m.hook,
        outcome: m.outcome,
      });
      rt.metrics.interceptorDuration.observe(
        { extension: m.extension, interceptor: m.interceptor },
        m.durationMs,
      );
    },
  });

  if (needsQueue) {
    await queue.start();
    await kernel.declareQueues();
  }
  // Migrations and lifecycle transitions are release-pipeline steps (`pnpm db:migrate`); a process only verifies.
  await kernel.verifyMigrations();
  await kernel.warm();
  slot.status = {
    state: 'ready',
    extensions: kernel.extensions.map((e) => `${e.manifest.name}@${e.manifest.version}`),
  };
  rt.log.info(
    { extensions: slot.status.extensions, disabled: kernel.disabledNames },
    'extension kernel ready',
  );
  return kernel;
}

export function getKernel(): Promise<Kernel> {
  if (!holder.__soldKernel) {
    const rt = getRuntime();
    const slot: Slot = {
      promise: undefined as unknown as Promise<Kernel>,
      status: { state: 'booting' },
    };
    slot.promise = boot(rt, slot).catch((error: Error) => {
      slot.status = { state: 'failed', error: error.message };
      rt.log.error({ err: error }, 'extension kernel failed to boot');
      throw error;
    });
    // A rejected boot is observed via readiness; do not let it surface as an unhandled rejection.
    slot.promise.catch(() => undefined);
    holder.__soldKernel = slot;
  }
  return holder.__soldKernel.promise;
}

export function kernelStatus(): KernelStatus {
  return holder.__soldKernel?.status ?? { state: 'booting' };
}

/** Readiness probe: succeeds once the kernel booted, throws with the reason if it failed. */
export async function checkKernel(): Promise<void> {
  await getKernel();
}
