import { loadEnv } from '@sold/core/env';
import {
  createKernel,
  toKernelLogger,
  type GeneratedRegistry,
  type Kernel,
} from '@sold/core/extensions';
import {
  discoverExtensions,
  DiscoveryError,
  type DiscoveryResult,
} from '@sold/core/extensions/discovery';
import { createLogger } from '@sold/core/observability';
import { createDb, syncReportingViews, type Db, type PrimaryDb } from '@sold/db';
import { migrateExtension } from '@sold/db/extension-migrations';
import { PgBossQueue } from '@sold/jobs';
import type { CliContext } from '../lib/context';
import { CliError, ExitCode } from '../lib/errors';

export interface MigrateHandle {
  kernel: Kernel;
  /** Primary handle (owner privileges), for release-time steps such as syncing reporting views. Absent in test fakes. */
  db?: PrimaryDb;
  close(): Promise<void>;
}

/** Wiring seam so the command is testable without a database. */
export type KernelFactory = (ctx: CliContext, found: DiscoveryResult) => Promise<MigrateHandle>;

function registryFrom(found: DiscoveryResult): GeneratedRegistry {
  return {
    candidates: found.extensions.map((e) => ({ manifest: e.manifest, origin: e.origin })),
    entries: found.entries,
    services: found.services,
    migrationFiles: Object.fromEntries(found.extensions.map((e) => [e.name, e.migrationFiles])),
    roots: Object.fromEntries(found.extensions.map((e) => [e.name, e.root])),
  };
}

export const realKernelFactory: KernelFactory = async (ctx, found) => {
  const env = loadEnv(ctx.env);
  const log = createLogger({
    service: 'sold-ext-migrate',
    level: env.LOG_LEVEL,
    environment: env.SOLD_ENVIRONMENT,
  });
  const db: Db = createDb({
    primaryUrl: env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL,
    poolMax: 2,
    applicationName: 'sold-ext-migrate',
  });
  const queue = new PgBossQueue({
    connectionString: env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL,
    role: 'producer',
    poolMax: 2,
  });
  // Lifecycle hooks (onInstall/onEnable) may enqueue jobs, so the queue must be running.
  await queue.start();
  const kernel = createKernel({
    env,
    log: toKernelLogger(log),
    db,
    queue,
    registry: registryFrom(found),
    migrateExtension,
  });
  await kernel.declareQueues();
  return {
    kernel,
    db: db.primary,
    close: async () => {
      await queue.stop({ timeoutMs: 5_000 });
      await db.close();
    },
  };
};

/**
 * `sold ext:migrate`: the release-pipeline step for extensions. Applies each enabled extension's migrations (linted:
 * namespaced and online-safe), then reconciles the registry and runs lifecycle hooks on transitions. Web and worker
 * processes never do this: they only verify it happened.
 */
export async function extMigrate(
  ctx: CliContext,
  factory: KernelFactory = realKernelFactory,
): Promise<void> {
  let found: DiscoveryResult;
  try {
    found = await discoverExtensions(ctx.cwd);
  } catch (error) {
    if (error instanceof DiscoveryError) throw new CliError(error.message, ExitCode.failure);
    throw error;
  }
  if (ctx.dryRun) {
    for (const e of found.extensions)
      ctx.out.info(`would migrate ${e.name}: ${e.migrationFiles.join(', ') || 'no migrations'}`);
    return;
  }
  const handle = await factory(ctx, found);
  try {
    const migrated = await handle.kernel.migrate();
    for (const m of migrated)
      ctx.out.info(
        `${m.extension}: ${m.applied.length === 0 ? 'migrations up to date' : `applied ${m.applied.join(', ')}`}`,
      );
    const r = await handle.kernel.reconcile();
    const parts = (['installed', 'enabled', 'disabled'] as const)
      .filter((k) => r[k].length > 0)
      .map((k) => `${k}: ${r[k].join(', ')}`);
    ctx.out.info(
      parts.length === 0 ? 'extensions: no lifecycle changes' : `extensions: ${parts.join('; ')}`,
    );
    // Reporting views declared by enabled extensions: validated (own tables only, plain SELECT), created, and removed when gone.
    if (handle.db) {
      const enabled = new Set(found.entries.filter((e) => e.enabled).map((e) => e.name));
      const report = await syncReportingViews(
        handle.db,
        found.extensions
          .filter((e) => enabled.has(e.name))
          .flatMap((e) =>
            e.manifest.reportingViews.map((v) => ({ extension: e.name, name: v.name, sql: v.sql })),
          ),
      );
      if (report.created.length > 0) ctx.out.info(`reporting views: ${report.created.join(', ')}`);
      if (report.dropped.length > 0)
        ctx.out.info(`reporting views removed: ${report.dropped.join(', ')}`);
      for (const r of report.rejected)
        ctx.out.warn(`reporting view ${r.view} rejected: ${r.issues.join('; ')}`);
    }
  } finally {
    await handle.close();
  }
}
