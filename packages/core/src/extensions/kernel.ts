import { join } from 'node:path';
import {
  ExtensionIsolationError,
  provisionExtensionRole,
  prefixCollisions,
  purgeExtension,
  sharedExtensionDbProvider,
  type Db,
  type ExtensionDbProvider,
  type ExtensionRoleConfig,
} from '@sold/db';
import type {
  ExtensionContext,
  ExtensionLogger,
  InterceptorContext,
  ServiceProvider,
} from '@sold/extension-sdk';
import type { EnvelopeCrypto } from '../crypto/envelope';
import type { JobQueue } from '../jobs/queue';
import { Semaphore } from '../resilience/semaphore';
import { BASE_VERSION } from '../version';
import { EventBus, observerQueue, type ObserverJob } from './event-bus';
import { installHotPathGuard } from './hot-path-guard';
import { InterceptorRunner, type InterceptorMetric } from './interceptor-runner';
import {
  ExtensionLoadError,
  resolveLoadOrder,
  type ExtensionCandidate,
  type ExtensionEntry,
  type LoadedExtension,
} from './load-order';
import { denyAll, PermissionRegistry, type Authorizer } from './permissions';
import { PgExtensionRegistry, PgSettingsStore } from './pg-stores';
import { RouteTable } from './route-table';
import { ServiceRegistry, type ProviderOrigin } from './service-registry';
import {
  SettingsService,
  noopAudit,
  type AuditSink,
  type RotationReport,
  type SettingsHealth,
} from './settings';

export interface KernelLogger extends ExtensionLogger {
  child(bindings: Record<string, unknown>): KernelLogger;
}

export interface BaseServiceProvider {
  provider: ServiceProvider;
}

export interface KernelDeps {
  baseVersion?: string;
  config: { extensions: readonly ExtensionEntry[]; services?: Readonly<Record<string, string>> };
  candidates: readonly ExtensionCandidate[];
  /** Absolute directory of an extension's package (its `migrations.dir` is relative to it). Needed to run migrations. */
  extensionRoot(name: string): string | undefined;
  /**
   * Names of an extension's migration files, known at build time. Web and worker processes verify against
   * this list instead of reading the filesystem, because the runtime image does not contain `extensions/`.
   * Defaults to reading `extensionRoot`.
   */
  migrationFiles?(name: string): readonly string[] | Promise<readonly string[]>;
  db: Db;
  /** Direct (session) connection for migrations and advisory locks. */
  migrationUrl: string;
  /**
   * Applies one extension's migrations (lint + run). Supplied ONLY by the release-pipeline CLI: web and worker
   * processes never migrate, so the migration linter and its parser stay out of the runtime bundles.
   */
  migrateExtension?(opts: {
    url: string;
    dir: string;
    extension: string;
    /** Every extension this instance knows: names in another one's longer namespace are not this extension's. */
    knownExtensions?: readonly string[];
  }): Promise<{ applied: string[] }>;
  /**
   * Where `ctx.db` comes from. `createKernel` builds an enforcing provider (one least-privilege database role and
   * pool per extension) from the environment; without one the kernel falls back to the SHARED application pools,
   * which gives extensions the application's privileges and is logged as a warning (ADR-0004).
   */
  extensionDb?: ExtensionDbProvider;
  /**
   * Role provisioning parameters. Present when isolation is enforced; used by the release pipeline (`migrate`,
   * `reconcile`, `uninstall`), which runs as a principal that may create roles.
   */
  isolation?: ExtensionRoleConfig;
  queue: JobQueue;
  crypto: EnvelopeCrypto;
  audit?: AuditSink;
  authorizer?: Authorizer;
  log: KernelLogger;
  /** Base's own default providers, lowest precedence. */
  baseProviders?: readonly BaseServiceProvider[];
  onInterceptorMetric?(metric: InterceptorMetric): void;
  interceptorPool?: { size?: number; queue?: number };
}

export interface ReconcileReport {
  installed: string[];
  enabled: string[];
  disabled: string[];
  unchanged: string[];
}

const LIFECYCLE_LOCK = 7_265_034_212;

/**
 * The extension kernel: turns validated manifests into a running system. Construction is pure (no
 * database access), so booting with zero extensions or with all of them is cheap and testable.
 * Migrations and lifecycle transitions are explicit steps run by the release pipeline (`migrate`,
 * `reconcile`); web and worker processes only `verifyMigrations`.
 */
export class Kernel {
  readonly permissions = new PermissionRegistry();
  readonly services = new ServiceRegistry();
  readonly routes = new RouteTable();
  readonly settings: SettingsService;
  readonly bus: EventBus;
  readonly interceptors: InterceptorRunner;
  readonly authorizer: Authorizer;
  private readonly registry: PgExtensionRegistry;
  private readonly extensionDb: ExtensionDbProvider;
  private readonly manifests = new Map<string, LoadedExtension>();

  private constructor(
    private readonly deps: KernelDeps,
    readonly extensions: readonly LoadedExtension[],
    readonly disabledNames: readonly string[],
  ) {
    this.authorizer = deps.authorizer ?? denyAll;
    for (const e of extensions) this.manifests.set(e.manifest.name, e);
    this.registry = new PgExtensionRegistry(deps.db.primary);
    this.extensionDb = deps.extensionDb ?? sharedExtensionDbProvider(deps.db);
    this.settings = new SettingsService({
      store: new PgSettingsStore(deps.db.primary),
      crypto: deps.crypto,
      audit: deps.audit ?? noopAudit,
      onError: (extension, error) =>
        deps.log.warn(
          { extension, err: error.name },
          'extension settings could not be read: the extension runs degraded',
        ),
    });
    if (this.extensionDb.mode === 'off' && extensions.length > 0)
      deps.log.warn(
        { extensions: extensions.map((e) => e.manifest.name) },
        'extension database isolation is OFF: extensions share the application database privileges (local development only)',
      );

    for (const b of deps.baseProviders ?? []) this.services.register(b.provider, 'base', 'base');
    for (const { manifest, origin } of extensions) {
      this.permissions.register(manifest);
      this.settings.register(manifest);
      this.routes.add(manifest);
      for (const p of manifest.services)
        this.services.register(p, origin satisfies ProviderOrigin, manifest.name);
    }
    this.services.resolve(deps.config.services ?? {});

    this.bus = new EventBus({
      extensions,
      dispatcher: {
        dispatch: async (job, idempotencyKey) => {
          await deps.queue.enqueue(observerQueue(job.extension), job, { idempotencyKey });
        },
      },
      contextFor: (extension, signal) => this.contextFor(extension, signal),
      onLog: (level, fields, message) => deps.log[level](fields, message),
    });

    this.interceptors = new InterceptorRunner({
      extensions,
      contextFor: (extension, budgetMs, signal) =>
        this.interceptorContextFor(extension, budgetMs, signal),
      pool: new Semaphore(
        'interceptors',
        deps.interceptorPool?.size ?? 32,
        deps.interceptorPool?.queue ?? 64,
      ),
      ...(deps.onInterceptorMetric ? { onMetric: deps.onInterceptorMetric } : {}),
      onLog: (level, fields, message) => deps.log[level](fields, message),
    });
  }

  /** Resolve load order and wire registries. Throws `ExtensionLoadError` listing every problem. No I/O. */
  static create(deps: KernelDeps): Kernel {
    installHotPathGuard();
    const extensions = resolveLoadOrder({
      baseVersion: deps.baseVersion ?? BASE_VERSION,
      candidates: deps.candidates,
      entries: deps.config.extensions,
    });

    // Cross-checks that need the whole set.
    const issues: string[] = [];
    // Table prefixes must be delimiter-safe across EVERY known extension (enabled or not): with `foo` and `foo-bar`
    // the tables `ext_foo_bar_*` would belong to both, and purge/lint could not tell them apart.
    const known = deps.candidates.map((c) => c.manifest.name);
    for (const name of known)
      if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name))
        issues.push(
          `extension "${name}": names may not end with a hyphen or contain "--" (the table prefix must be unambiguous)`,
        );
    for (const [a, b] of prefixCollisions(known))
      issues.push(
        `extensions "${a}" and "${b}" have overlapping table prefixes (ext_${a.replaceAll('-', '_')}_ is a prefix of ext_${b.replaceAll('-', '_')}_): rename one`,
      );
    const perms = new PermissionRegistry();
    for (const e of extensions) perms.register(e.manifest);
    for (const { manifest } of extensions) {
      for (const r of manifest.routes) {
        if (r.permission && !perms.has(r.permission))
          issues.push(
            `extension "${manifest.name}": route ${r.method} ${r.path} uses unknown permission "${r.permission}"`,
          );
      }
      for (const s of manifest.adminScreens) {
        if (!perms.has(s.permission))
          issues.push(
            `extension "${manifest.name}": admin screen ${s.path} uses unknown permission "${s.permission}"`,
          );
      }
    }
    if (issues.length > 0) throw new ExtensionLoadError(issues);

    const disabledNames = deps.config.extensions.filter((e) => !e.enabled).map((e) => e.name);
    return new Kernel(deps, extensions, disabledNames);
  }

  get(name: string): LoadedExtension | undefined {
    return this.manifests.get(name);
  }

  // ---- contexts -------------------------------------------------------------------------------

  private logFor(extension: string): ExtensionLogger {
    return this.deps.log.child({ extension });
  }

  contextFor(extension: string, signal: AbortSignal): ExtensionContext {
    const local = new Set((this.manifests.get(extension)?.manifest.jobs ?? []).map((j) => j.queue));
    return {
      extension,
      log: this.logFor(extension),
      signal,
      // In `enforce` mode these handles connect as the extension's own database role (ADR-0004).
      db: this.extensionDb.for(extension),
      settings: { get: () => this.settings.get(extension) },
      queue: {
        enqueue: async (queue, data, options) => {
          if (!local.has(queue))
            throw new Error(`Extension "${extension}" has no job queue "${queue}"`);
          return this.deps.queue.enqueue(`ext.${extension}.${queue}`, data, options);
        },
      },
    };
  }

  /** Interceptors get NO I/O: settings come from a memory snapshot, never the database. */
  private interceptorContextFor(
    extension: string,
    budgetMs: number,
    signal: AbortSignal,
  ): InterceptorContext {
    return {
      extension,
      budgetMs,
      signal,
      log: this.logFor(extension),
      // Memory only. Before the first warm-up the schema defaults apply, so the typed contract always holds.
      settings: {
        get: async () =>
          this.settings.snapshot(extension) ??
          (this.settings.has(extension) ? this.settings.defaults(extension) : {}),
      },
    };
  }

  // ---- release-pipeline steps (explicit, not run at web boot) -----------------------------------

  /** Every extension this instance knows: configured candidates plus anything the registry still records. */
  private async knownExtensionNames(): Promise<string[]> {
    const names = new Set(this.deps.candidates.map((c) => c.manifest.name));
    for (const row of await this.registry.list()) names.add(row.name);
    return [...names];
  }

  /**
   * Create the extension's database role and align its privileges with the tables that exist now (release pipeline
   * only). A no-op when isolation is not enforced.
   */
  private async provision(extension: string): Promise<void> {
    if (!this.deps.isolation) return;
    const result = await provisionExtensionRole(this.deps.db.pools.primary, {
      extension,
      otherExtensions: await this.knownExtensionNames(),
      config: this.deps.isolation,
    });
    if (result.ignored.length > 0)
      this.deps.log.warn(
        { extension, ignored: result.ignored },
        'objects with the extension prefix are not valid owned names and were NOT granted to its role',
      );
  }

  /**
   * Apply each enabled extension's forward-only migrations under its own journal scope (linted first: the same
   * allowlist gate CI runs), then create/refresh its database role and per-table grants.
   */
  async migrate(): Promise<{ extension: string; applied: string[] }[]> {
    const out: { extension: string; applied: string[] }[] = [];
    const known = await this.knownExtensionNames();
    for (const { manifest } of this.extensions) {
      if (manifest.migrations) {
        const root = this.deps.extensionRoot(manifest.name);
        if (!root)
          throw new Error(`Cannot locate the package directory of extension "${manifest.name}"`);
        if (!this.deps.migrateExtension) {
          throw new Error(
            'This process cannot run migrations: use `pnpm sold ext:migrate` (the release pipeline step)',
          );
        }
        const result = await this.deps.migrateExtension({
          url: this.deps.migrationUrl,
          dir: join(root, manifest.migrations.dir),
          extension: manifest.name,
          knownExtensions: known,
        });
        out.push({ extension: manifest.name, applied: result.applied });
      }
      // Grants are per table and must follow the tables: re-issued on every run, also when nothing was applied.
      await this.provision(manifest.name);
    }
    return out;
  }

  /**
   * Fails fast if any enabled extension has unapplied migrations (web/worker boot check). Compares the exact
   * set of migration names, so a missing or extra journal entry is caught, not just a count mismatch.
   */
  async verifyMigrations(): Promise<void> {
    const { rows } = await this.deps.db.pools.primary.query<{ scope: string; name: string }>(
      `SELECT scope, name FROM _sold_migrations WHERE scope LIKE 'ext:%'`,
    );
    const applied = new Map<string, Set<string>>();
    for (const r of rows) applied.set(r.scope, (applied.get(r.scope) ?? new Set()).add(r.name));
    const problems: string[] = [];
    for (const { manifest } of this.extensions) {
      if (!manifest.migrations) continue;
      const expected = await this.expectedMigrations(manifest.name, manifest.migrations.dir);
      const have = applied.get(`ext:${manifest.name}`) ?? new Set<string>();
      const missing = expected.filter((n) => !have.has(n));
      if (missing.length > 0) problems.push(`${manifest.name} (${missing.join(', ')})`);
    }
    if (problems.length > 0) {
      throw new Error(
        `Extension migrations are not applied for: ${problems.join('; ')}. Run the migration step (pnpm db:migrate) before starting.`,
      );
    }
    await this.verifyIsolation();
  }

  /**
   * Boot-time check that every enabled extension's database handle really is the least-privilege role: it connects
   * (the release step provisioned it), it is not privileged, and it cannot touch the tables that hold platform state
   * and secrets. Fails closed: a misconfigured or stale role must not serve traffic.
   */
  async verifyIsolation(): Promise<void> {
    if (this.extensionDb.mode !== 'enforce') return;
    const problems: string[] = [];
    for (const { manifest } of this.extensions) {
      try {
        const { problems: found } = await this.extensionDb.verify(manifest.name);
        for (const p of found) problems.push(`${manifest.name}: ${p}`);
      } catch (error) {
        problems.push(
          `${manifest.name}: cannot connect as role ${this.extensionDb.roleFor(manifest.name)} (${(error as Error).message}). Run \`sold ext:migrate\` to provision it.`,
        );
      }
    }
    if (problems.length > 0)
      throw new ExtensionIsolationError(
        `Extension database isolation check failed: ${problems.join('; ')}`,
      );
  }

  private async expectedMigrations(name: string, dir: string): Promise<readonly string[]> {
    if (this.deps.migrationFiles) return this.deps.migrationFiles(name);
    const root = this.deps.extensionRoot(name);
    if (!root) throw new Error(`Cannot locate the package directory of extension "${name}"`);
    const { readdir } = await import('node:fs/promises');
    return (await readdir(join(root, dir))).filter((f) => f.endsWith('.sql')).sort();
  }

  /**
   * Bring the registry in line with `sold.config.ts` and run lifecycle hooks on transitions:
   * new -> onInstall + onEnable; disabled -> enabled: onEnable; enabled -> disabled/removed: onDisable.
   * Serialised across concurrent deploys with an advisory lock. Hooks that throw abort the run and leave
   * that extension's state unchanged, so the step can be retried.
   */
  async reconcile(): Promise<ReconcileReport> {
    const report: ReconcileReport = { installed: [], enabled: [], disabled: [], unchanged: [] };
    const conn = await this.deps.db.pools.primary.connect();
    try {
      await conn.query('SELECT pg_advisory_lock($1)', [LIFECYCLE_LOCK]);
      const existing = new Map((await this.registry.list()).map((r) => [r.name, r]));
      const ac = new AbortController();

      for (const { manifest } of this.extensions) {
        const row = existing.get(manifest.name);
        const ctx = this.contextFor(manifest.name, ac.signal);
        // The role must exist (with grants for the tables that exist now) before any hook uses `ctx.db`.
        await this.provision(manifest.name);
        if (!row || row.state === 'installing') {
          // The registry row must exist before onInstall so hooks can use settings (FK to the registry). It is
          // recorded as `installing` and only becomes `enabled` after onInstall AND onEnable succeed, so a crash
          // in between (SIGKILL, OOM) leaves `installing` behind and the next run installs again. Hooks must
          // therefore be idempotent (docs/extending.md).
          if (!row) await this.registry.beginInstall(manifest.name, manifest.version);
          try {
            await manifest.lifecycle.onInstall?.(ctx as never);
            await manifest.lifecycle.onEnable?.(ctx as never);
          } catch (error) {
            // A hook that FAILED (as opposed to a crash) rolls the attempt back, so the step can be retried cleanly.
            if (!row) await this.registry.remove(manifest.name);
            throw new Error(
              `Extension "${manifest.name}" failed to install: ${(error as Error).message}`,
              { cause: error },
            );
          }
          await this.registry.upsert(manifest.name, manifest.version, 'enabled');
          report.installed.push(manifest.name);
        } else if (row.state === 'disabled') {
          try {
            await manifest.lifecycle.onEnable?.(ctx as never);
          } catch (error) {
            throw new Error(
              `Extension "${manifest.name}" failed to enable: ${(error as Error).message}`,
              { cause: error },
            );
          }
          await this.registry.upsert(manifest.name, manifest.version, 'enabled');
          report.enabled.push(manifest.name);
        } else {
          if (row.version !== manifest.version)
            await this.registry.upsert(manifest.name, manifest.version, 'enabled');
          report.unchanged.push(manifest.name);
        }
      }

      // Anything enabled in the registry but no longer loaded (disabled or removed from config).
      const loaded = new Set(this.extensions.map((e) => e.manifest.name));
      for (const row of existing.values()) {
        if (row.state !== 'enabled' || loaded.has(row.name)) continue;
        const candidate = this.deps.candidates.find((c) => c.manifest.name === row.name);
        if (candidate) {
          try {
            await candidate.manifest.lifecycle.onDisable?.(
              this.contextFor(row.name, ac.signal) as never,
            );
          } catch (error) {
            throw new Error(
              `Extension "${row.name}" failed to disable: ${(error as Error).message}`,
              { cause: error },
            );
          }
        } else {
          this.deps.log.warn(
            { extension: row.name },
            'extension is no longer installed: marking disabled without running onDisable',
          );
        }
        await this.registry.upsert(row.name, row.version, 'disabled');
        report.disabled.push(row.name);
      }
      return report;
    } finally {
      await conn.query('SELECT pg_advisory_unlock($1)', [LIFECYCLE_LOCK]).catch(() => undefined);
      conn.release();
    }
  }

  /**
   * Explicit removal (`sold ext:uninstall <name> --purge`). Runs `onUninstall`, then in ONE transaction drops every
   * object the extension owns (tables, views, sequences, functions, types), deletes its migration journal rows,
   * its registry row (cascading its settings) and its database role, so a later reinstall starts clean. Object names
   * come from the catalogue and are always quoted, never interpolated. Never automatic: disabling an extension
   * keeps its data. Refuses when another known extension's table prefix overlaps this one.
   */
  async uninstall(
    name: string,
    opts: { purge: boolean },
  ): Promise<{
    droppedTables: string[];
    dropped: Awaited<ReturnType<typeof purgeExtension>>['dropped'];
    roleDropped: boolean;
  }> {
    const candidate = this.deps.candidates.find((c) => c.manifest.name === name);
    if (!candidate) throw new Error(`Extension "${name}" is not installed`);
    if (this.manifests.has(name))
      throw new Error(`Extension "${name}" is still enabled: disable it in sold.config.ts first`);
    if (!opts.purge)
      throw new Error(
        'Refusing to uninstall without --purge: this permanently deletes the extension data',
      );
    const known = await this.knownExtensionNames();
    // Fail before running any hook if the objects cannot be attributed unambiguously.
    const overlapping = prefixCollisions(known).filter(([a, b]) => a === name || b === name);
    if (overlapping.length > 0)
      throw new ExtensionIsolationError(
        `Refusing to purge "${name}": its table prefix overlaps with ${overlapping.map(([a, b]) => (a === name ? b : a)).join(', ')}, so its objects cannot be told apart from theirs.`,
      );
    await candidate.manifest.lifecycle.onUninstall?.(
      this.contextFor(name, new AbortController().signal) as never,
    );
    const client = await this.deps.db.pools.primary.connect();
    try {
      const result = await purgeExtension(client, {
        extension: name,
        knownExtensions: known,
        config: this.deps.isolation,
      });
      if (!result.roleDropped)
        this.deps.log.warn(
          { extension: name, err: result.roleDropError },
          'the extension database role could not be dropped (privileges in another database of this cluster?): drop it by hand',
        );
      return {
        droppedTables: result.dropped.tables,
        dropped: result.dropped,
        roleDropped: result.roleDropped,
      };
    } finally {
      client.release();
    }
  }

  // ---- queues (worker) -----------------------------------------------------------------------

  /** Declare every extension queue so enqueueing works from any process. */
  async declareQueues(): Promise<void> {
    for (const { manifest } of this.extensions) {
      if (manifest.observers.length > 0)
        await this.deps.queue.ensureQueue({ name: observerQueue(manifest.name), class: 'default' });
      for (const job of manifest.jobs)
        await this.deps.queue.ensureQueue({
          name: `ext.${manifest.name}.${job.queue}`,
          class: job.class,
        });
    }
  }

  /** Worker only: start consuming observer deliveries, jobs and schedules. */
  async startWorkers(): Promise<void> {
    await this.declareQueues();
    for (const { manifest } of this.extensions) {
      if (manifest.observers.length > 0) {
        await this.deps.queue.work<ObserverJob>(observerQueue(manifest.name), async (job) => {
          await this.bus.deliver(job.data, job.retryCount);
        });
      }
      for (const def of manifest.jobs) {
        const queue = `ext.${manifest.name}.${def.queue}`;
        await this.deps.queue.work<object>(queue, async (job) => {
          const controller = new AbortController();
          const data = def.dataSchema ? def.dataSchema.parse(job.data) : job.data;
          try {
            await def.handler(
              { id: job.id, data: data as never, retryCount: job.retryCount },
              this.contextFor(manifest.name, controller.signal) as never,
            );
          } catch (error) {
            controller.abort();
            this.deps.log.error(
              {
                extension: manifest.name,
                queue: def.queue,
                jobId: job.id,
                err: error instanceof Error ? error.message : String(error),
              },
              'extension job failed',
            );
            throw error;
          }
        });
      }
      for (const s of manifest.schedules) {
        await this.deps.queue.schedule(
          `ext.${manifest.name}.${s.queue}`,
          s.cron,
          s.data ?? {},
          `${manifest.name}/${s.queue}`,
        );
      }
    }
  }

  /**
   * Warm the in-memory settings snapshots that hot-path interceptors read, and keep them fresh in the background
   * (jittered, unref'd timer; see `SettingsService`). An extension whose settings cannot be read is reported in
   * `health()` instead of failing the boot.
   */
  async warm(): Promise<SettingsHealth> {
    const health = await this.settings.warm();
    this.settings.startRefresh();
    return health;
  }

  /** Readiness detail: extensions that run degraded, and how `ctx.db` is scoped. */
  health(): {
    settings: SettingsHealth;
    extensionDb: { mode: 'enforce' | 'off'; pools: ReturnType<ExtensionDbProvider['stats']> };
  } {
    return {
      settings: this.settings.health(),
      extensionDb: { mode: this.extensionDb.mode, pools: this.extensionDb.stats() },
    };
  }

  /** Re-encrypt every stored secret under the current root key (`sold ext:settings:rotate`). */
  async rotateSettings(actor = 'system:rotate'): Promise<RotationReport> {
    return this.settings.rotate(actor);
  }

  /** Stop background timers and release the extension database pools. */
  async close(): Promise<void> {
    this.settings.stopRefresh();
    await this.extensionDb.close();
  }

  /** Machine-readable summary for `/api/version`-style diagnostics and generated docs. */
  describe(): {
    order: string[];
    disabled: readonly string[];
    services: ReturnType<ServiceRegistry['list']>;
    permissions: number;
    routes: number;
    extensionDbIsolation: 'enforce' | 'off';
  } {
    return {
      extensionDbIsolation: this.extensionDb.mode,
      order: this.extensions.map((e) => `${e.manifest.name}@${e.manifest.version}`),
      disabled: this.disabledNames,
      services: this.services.list(),
      permissions: this.permissions.list().length,
      routes: this.routes.list().length,
    };
  }
}
