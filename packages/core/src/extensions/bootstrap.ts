import type { Db } from '@sold/db';
import type { Env } from '../env';
import { EnvelopeCrypto, rootKeyFromBase64 } from '../crypto/envelope';
import type { JobQueue } from '../jobs/queue';
import { Kernel, type BaseServiceProvider, type KernelDeps, type KernelLogger } from './kernel';
import type { InterceptorMetric } from './interceptor-runner';
import type { ExtensionCandidate, ExtensionEntry } from './load-order';

/** The shape of the build-time generated module (`apps/web/.generated/extensions.ts`, see `discovery.ts`). */
export interface GeneratedRegistry {
  candidates: ExtensionCandidate[];
  entries: ExtensionEntry[];
  services: Record<string, string>;
  migrationFiles: Record<string, readonly string[]>;
  roots: Record<string, string>;
}

/**
 * A fixed, PUBLIC development key, used only when `SOLD_ENVIRONMENT=local` and no key is configured, so encrypted
 * settings survive a restart on a developer's machine. It protects nothing: every other environment must provide
 * `SOLD_SECRET_KEY` (the env schema enforces it).
 */
const LOCAL_DEV_KEY = Buffer.alloc(32, 'sold-local-dev-key-not-a-secret').toString('base64');

export function cryptoFromEnv(
  env: Pick<Env, 'SOLD_SECRET_KEY' | 'SOLD_ENVIRONMENT'>,
): EnvelopeCrypto {
  if (env.SOLD_SECRET_KEY) return new EnvelopeCrypto(rootKeyFromBase64(env.SOLD_SECRET_KEY));
  if (env.SOLD_ENVIRONMENT === 'local') return new EnvelopeCrypto(rootKeyFromBase64(LOCAL_DEV_KEY));
  throw new Error('SOLD_SECRET_KEY is required outside local');
}

/** Structural adapter: pino's `child()` and level methods already match `KernelLogger`. */
export function toKernelLogger(log: {
  child(bindings: Record<string, unknown>): unknown;
  debug: KernelLogger['debug'];
  info: KernelLogger['info'];
  warn: KernelLogger['warn'];
  error: KernelLogger['error'];
}): KernelLogger {
  return {
    debug: (f, m) => log.debug(f, m),
    info: (f, m) => log.info(f, m),
    warn: (f, m) => log.warn(f, m),
    error: (f, m) => log.error(f, m),
    child: (bindings) =>
      toKernelLogger(log.child(bindings) as Parameters<typeof toKernelLogger>[0]),
  };
}

export interface CreateKernelOptions {
  env: Env;
  log: KernelLogger;
  db: Db;
  queue: JobQueue;
  registry: GeneratedRegistry;
  baseProviders?: readonly BaseServiceProvider[];
  /** Only the release-pipeline CLI passes this. */
  migrateExtension?: KernelDeps['migrateExtension'];
  onInterceptorMetric?(metric: InterceptorMetric): void;
}

/** Wire a kernel from the environment and the build-time registry. Pure: no I/O until `migrate`/`reconcile`/`start`. */
export function createKernel(opts: CreateKernelOptions): Kernel {
  const { env, registry } = opts;
  return Kernel.create({
    config: { extensions: registry.entries, services: registry.services },
    candidates: registry.candidates,
    extensionRoot: (name) => registry.roots[name],
    migrationFiles: (name) => registry.migrationFiles[name] ?? [],
    db: opts.db,
    migrationUrl: env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL,
    queue: opts.queue,
    crypto: cryptoFromEnv(env),
    log: opts.log,
    ...(opts.baseProviders ? { baseProviders: opts.baseProviders } : {}),
    ...(opts.migrateExtension ? { migrateExtension: opts.migrateExtension } : {}),
    ...(opts.onInterceptorMetric ? { onInterceptorMetric: opts.onInterceptorMetric } : {}),
  });
}
