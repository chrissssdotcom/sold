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
  | {
      state: 'ready';
      extensions: string[];
      /** Extensions running degraded (e.g. a stored secret no configured key can decrypt). The kernel itself is healthy. */
      degraded: { extension: string; reason: string }[];
      extensionDbIsolation: 'enforce' | 'off';
    }
  | { state: 'failed'; error: string };

interface Slot {
  promise: Promise<Kernel>;
  status: KernelStatus;
  kernel?: Kernel;
}

/**
 * Next bundles route handlers, instrumentation and the worker separately, so this module can be instantiated more
 * than once per process; the kernel must still be a singleton. The slot therefore lives on `globalThis` under a
 * registry symbol (`Symbol.for`, shared across module copies), defined NON-ENUMERABLE so it does not show up in
 * `Object.keys(globalThis)`, `JSON.stringify` or a casual inspection.
 *
 * This is NOT a security boundary: any in-process code can call `Symbol.for(...)` and reach the kernel. Extensions
 * are trusted, reviewed, in-process code (ADR-0004); what is enforced is database privilege, lint and review. The
 * slot deliberately holds nothing but the kernel promise and a status: no key material and no environment.
 */
const SLOT = Symbol.for('sold.web.kernel.slot');

function readSlot(): Slot | undefined {
  return (globalThis as unknown as Record<symbol, Slot | undefined>)[SLOT];
}
function writeSlot(slot: Slot): void {
  Object.defineProperty(globalThis, SLOT, {
    value: slot,
    enumerable: false,
    writable: true,
    configurable: true,
  });
}

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
  // Also verifies extension database isolation (each extension's role connects and is least-privilege).
  await kernel.verifyMigrations();
  // Warms the settings snapshots and starts the background refresh. An extension whose settings cannot be read
  // degrades (reported by `kernelStatus`); it does not fail the boot.
  await kernel.warm();
  slot.kernel = kernel;
  const health = kernel.health();
  slot.status = readyStatus(kernel);
  rt.log.info(
    {
      extensions: slot.status.extensions,
      disabled: kernel.disabledNames,
      degraded: health.settings.degraded.map((d) => d.extension),
      extensionDbIsolation: health.extensionDb.mode,
    },
    'extension kernel ready',
  );
  return kernel;
}

function readyStatus(kernel: Kernel): Extract<KernelStatus, { state: 'ready' }> {
  const health = kernel.health();
  return {
    state: 'ready',
    extensions: kernel.extensions.map((e) => `${e.manifest.name}@${e.manifest.version}`),
    degraded: health.settings.degraded,
    extensionDbIsolation: health.extensionDb.mode,
  };
}

export function getKernel(): Promise<Kernel> {
  if (!readSlot()) {
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
    writeSlot(slot);
  }
  return (readSlot() as Slot).promise;
}

/** Current status. Degradation is live: it is recomputed from the kernel on every call, not frozen at boot. */
export function kernelStatus(): KernelStatus {
  const slot = readSlot();
  if (slot?.kernel && slot.status.state === 'ready') return readyStatus(slot.kernel);
  return slot?.status ?? { state: 'booting' };
}

/** Stop the kernel's timers and release the extension database pools (graceful shutdown). */
export async function closeKernel(): Promise<void> {
  const slot = readSlot();
  if (!slot?.kernel) return;
  await slot.kernel.close();
}

/** Readiness probe: succeeds once the kernel booted, throws with the reason if it failed. */
export async function checkKernel(): Promise<void> {
  await getKernel();
}
