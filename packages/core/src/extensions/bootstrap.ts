import {
  scopedExtensionDbProvider,
  sharedExtensionDbProvider,
  type Db,
  type ExtensionRoleConfig,
} from '@sold/db';
import { extensionDbIsolation, type Env } from '../env';
import { EnvelopeCrypto, rootKeyFromBase64, rootKeysFromList } from '../crypto/envelope';
import type { JobQueue } from '../jobs/queue';
import { Kernel, type BaseServiceProvider, type KernelDeps, type KernelLogger } from './kernel';
import type { InterceptorMetric } from './interceptor-runner';
import type { ExtensionCandidate, ExtensionEntry } from './load-order';
import type { Authorizer } from './permissions';

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

/**
 * The root key is read here, once, when the kernel is created; nothing in this module keeps it afterwards. (Other
 * code that reads `SOLD_SECRET_KEY` lazily from the environment is not affected, so the variable stays in
 * `process.env`: in-process extension code can read it. That is the ADR-0004 trust model, not a sandbox.)
 * `SOLD_SECRET_KEY_PREVIOUS` (comma-separated) lets a rotation decrypt values written under the old key.
 */
export function cryptoFromEnv(
  env: Pick<Env, 'SOLD_SECRET_KEY' | 'SOLD_SECRET_KEY_PREVIOUS' | 'SOLD_ENVIRONMENT'>,
): EnvelopeCrypto {
  if (env.SOLD_SECRET_KEY)
    return new EnvelopeCrypto(
      rootKeyFromBase64(env.SOLD_SECRET_KEY),
      rootKeysFromList(env.SOLD_SECRET_KEY_PREVIOUS),
    );
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
  /** Decides whether an actor may use a non-public extension route. Default: deny everything (fail closed). */
  authorizer?: Authorizer;
  /** Only the release-pipeline CLI passes this. */
  migrateExtension?: KernelDeps['migrateExtension'];
  onInterceptorMetric?(metric: InterceptorMetric): void;
}

/** Role parameters for extension database isolation, or `undefined` when it is off. */
export function extensionRoleConfig(
  env: Env,
  hasExtensions = true,
): ExtensionRoleConfig | undefined {
  if (extensionDbIsolation(env) !== 'enforce') return undefined;
  if (!env.SOLD_EXTENSION_DB_SECRET) {
    if (!hasExtensions) return undefined; // nothing to isolate: an instance without extensions needs no secret
    throw new Error(
      'SOLD_EXTENSION_DB_SECRET (>= 32 characters) is required when extension database isolation is enforced and extensions are enabled',
    );
  }
  return {
    rolePrefix: env.SOLD_EXTENSION_DB_ROLE_PREFIX,
    secret: env.SOLD_EXTENSION_DB_SECRET,
    statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
    lockTimeoutMs: env.DB_LOCK_TIMEOUT_MS,
    idleInTransactionTimeoutMs: env.DB_IDLE_IN_TX_TIMEOUT_MS,
  };
}

/** Wire a kernel from the environment and the build-time registry. Pure: no I/O until `migrate`/`reconcile`/`start`. */
export function createKernel(opts: CreateKernelOptions): Kernel {
  const { env, registry } = opts;
  const isolation = extensionRoleConfig(
    env,
    registry.entries.some((e) => e.enabled),
  );
  return Kernel.create({
    extensionDb: isolation
      ? scopedExtensionDbProvider({
          primaryUrl: env.DATABASE_EXTENSION_URL ?? env.DATABASE_URL,
          replicaUrl: env.DATABASE_REPLICA_URL,
          config: isolation,
          poolMax: env.SOLD_EXTENSION_DB_POOL_MAX,
          pooler: env.DATABASE_POOLER,
          applicationName: `sold-${env.SOLD_ROLE}`,
        })
      : sharedExtensionDbProvider(opts.db),
    ...(isolation ? { isolation } : {}),
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
    ...(opts.authorizer ? { authorizer: opts.authorizer } : {}),
    ...(opts.migrateExtension ? { migrateExtension: opts.migrateExtension } : {}),
    ...(opts.onInterceptorMetric ? { onInterceptorMetric: opts.onInterceptorMetric } : {}),
  });
}
