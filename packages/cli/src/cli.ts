import { Command, CommanderError } from 'commander';
import { ZodError } from 'zod';
import type { CliContext } from './lib/context';
import { CliError, ExitCode } from './lib/errors';
import { customerNew } from './customer/new';
import { extDocs } from './ext/docs';
import { extList } from './ext/list';
import { extMigrate } from './ext/migrate';
import { extNew } from './ext/scaffold';
import { themeList, themeNew } from './theme/scaffold';
import { reportingEnableLogin } from './reporting/role';
import { userCreateOwner } from './user/owner';
import { extSync } from './ext/sync';
import {
  envCost,
  envDown,
  envExtend,
  envId,
  envList,
  envPause,
  envPlan,
  envResume,
  envUp,
} from './env/commands';
import { parseTtl } from './env/ttl';
import { releaseDeploy } from './release/deploy';
import { checkDeployFreeze } from './release/freeze';
import { promote, readRelease, stampRelease } from './release/promote';
import { formatVersionId } from './release/schemas';
import { stubDetails, notImplemented } from './stubs';
import { upgradeApply } from './upgrade/apply';
import { upgradeCheck } from './upgrade/check';
import { driftCheck } from './upgrade/drift';
import { Git } from './upgrade/git';
import { upgradePlan } from './upgrade/plan';

export interface RunDeps {
  /** Builds the context once the global flags are known. */
  createContext: (flags: { dryRun: boolean }) => CliContext;
  /** Where commander writes help/usage/errors. */
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
}

/**
 * Parses argv, runs the command and returns the process exit code. Never calls process.exit, so it is
 * fully testable with an injected context.
 */
export async function run(argv: string[], deps: RunDeps): Promise<number> {
  let exitCode: number = ExitCode.ok;
  let ctx: CliContext | undefined;

  const program = new Command('sold')
    .description('Sold platform CLI: environments, releases, upgrades, instance scaffolding')
    .option(
      '--dry-run',
      'print the exact terraform/az/cloudflare/git actions instead of executing them',
      false,
    )
    .exitOverride()
    .configureOutput({
      writeOut: deps.writeOut ?? ((t) => process.stdout.write(t)),
      writeErr: deps.writeErr ?? ((t) => process.stderr.write(t)),
    });

  /** Wraps a command body: builds the context, maps errors to exit codes. */
  const action =
    <A extends unknown[]>(body: (context: CliContext, ...args: A) => Promise<number | void>) =>
    async (...raw: unknown[]): Promise<void> => {
      const command = raw[raw.length - 1] as Command;
      const flags = command.optsWithGlobals<{ dryRun?: boolean }>();
      ctx = deps.createContext({ dryRun: flags.dryRun === true });
      try {
        const result = await body(ctx, ...(raw.slice(0, -1) as A));
        exitCode = typeof result === 'number' ? result : ExitCode.ok;
      } catch (error) {
        exitCode = reportError(ctx, error);
      }
    };

  // ---- environments -------------------------------------------------------------------------
  program
    .command('env:up')
    .description('create or update an environment (default: an ephemeral preview that expires)')
    .argument('<customer>', 'customer slug, e.g. demo')
    .argument('<env>', 'preview name (ephemeral) or dev/stage')
    .option('--profile <profile>', 'ephemeral | dev | stage', 'ephemeral')
    .option('--branch <branch>', 'branch the preview is built from (names the environment)')
    .option(
      '--ttl <duration>',
      'lifetime of an ephemeral environment: 90m, 48h, 2d (default 48h, max 7d)',
    )
    .option('--seed <name>', 'seed demo data after migrating (non-production only)')
    .option('--image <ref>', 'web image, repository@sha256:digest (ephemeral)')
    .option('--worker-image <ref>', 'worker image, repository@sha256:digest')
    .option('--migrate-image <ref>', 'migrate image, repository@sha256:digest')
    .option('--release-version <id>', '<base-version>+<customer>.<instance-build> (ephemeral)')
    .option('--owner <owner>', 'who owns (and is warned about) this environment')
    .option('--max-concurrent <n>', 'max ephemeral environments per customer', (v) =>
      Number.parseInt(v, 10),
    )
    .action(
      action(
        async (
          context,
          customer: string,
          env: string,
          options: Record<string, string | number | undefined>,
        ) => {
          await envUp(context, {
            customer,
            env,
            ...(options['profile'] !== undefined ? { profile: String(options['profile']) } : {}),
            ...(options['branch'] !== undefined ? { branch: String(options['branch']) } : {}),
            ...(options['ttl'] !== undefined ? { ttl: String(options['ttl']) } : {}),
            ...(options['seed'] !== undefined ? { seed: String(options['seed']) } : {}),
            ...(options['image'] !== undefined ? { image: String(options['image']) } : {}),
            ...(options['workerImage'] !== undefined
              ? { workerImage: String(options['workerImage']) }
              : {}),
            ...(options['migrateImage'] !== undefined
              ? { migrateImage: String(options['migrateImage']) }
              : {}),
            ...(options['releaseVersion'] !== undefined
              ? { releaseVersion: String(options['releaseVersion']) }
              : {}),
            ...(options['owner'] !== undefined ? { owner: String(options['owner']) } : {}),
            ...(typeof options['maxConcurrent'] === 'number'
              ? { maxConcurrent: options['maxConcurrent'] }
              : {}),
          });
        },
      ),
    );

  program
    .command('env:id')
    .description('print the env-id for a preview branch (or a persistent environment)')
    .option('--customer <customer>', 'default: instance.customer from sold.config.ts')
    .option('--branch <branch>', 'preview branch')
    .option('--env <name>', 'dev | stage | prod')
    .action(
      action(async (context, options: { customer?: string; branch?: string; env?: string }) => {
        await envId(context, options);
      }),
    );

  program
    .command('env:plan')
    .description(
      'read-only terraform plan of dev/stage/prod (exit 6 when there are changes); --json-out feeds the tag check',
    )
    .argument('<env-id>')
    .option('--json-out <file>', 'write the plan as JSON')
    .option('--no-lock', 'do not take the state lock (read-only drift identity)')
    .action(
      action(async (context, id: string, options: { jsonOut?: string; lock?: boolean }) =>
        envPlan(context, id, {
          ...(options.jsonOut ? { jsonOut: options.jsonOut } : {}),
          noLock: options.lock === false,
        }),
      ),
    );

  program
    .command('env:pause')
    .description('scale web/worker to zero and stop PostgreSQL (non-production; idempotent)')
    .argument('<env-id>', 'e.g. demo-dev or demo-eph-my-branch-1a2b')
    .action(action(async (context, envId: string) => envPause(context, envId)));

  program
    .command('env:resume')
    .description('start PostgreSQL and restore replicas')
    .argument('<env-id>')
    .action(action(async (context, envId: string) => envResume(context, envId)));

  program
    .command('env:extend')
    .description('extend an ephemeral environment (never beyond 7 days from now)')
    .argument('<env-id>')
    .requiredOption('--ttl <duration>', 'time to add, e.g. 24h')
    .action(
      action(async (context, envId: string, options: { ttl: string }) => {
        parseTtl(options.ttl);
        await envExtend(context, envId, options.ttl);
      }),
    );

  program
    .command('env:list')
    .description('list environments (from Azure resource-group tags)')
    .option('--customer <customer>')
    .option('--expired', 'only environments past their expires-at')
    .option(
      '--expiring-within <duration>',
      'only environments expiring within this window, e.g. 24h',
    )
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (
          context,
          options: {
            customer?: string;
            expired?: boolean;
            expiringWithin?: string;
            json?: boolean;
          },
        ) => {
          await envList(context, {
            ...(options.customer ? { customer: options.customer } : {}),
            ...(options.expired ? { expired: true } : {}),
            ...(options.expiringWithin
              ? { expiringWithinMs: parseTtl(options.expiringWithin) }
              : {}),
            ...(options.json ? { json: true } : {}),
          });
        },
      ),
    );

  program
    .command('env:cost')
    .description('month-to-date actual cost per environment (Azure Cost Management)')
    .argument('[env-id]')
    .option('--json')
    .action(
      action(async (context, envId: string | undefined, options: { json?: boolean }) => {
        await envCost(context, {
          ...(envId ? { envId } : {}),
          ...(options.json ? { json: true } : {}),
        });
      }),
    );

  program
    .command('env:down')
    .description('destroy an environment; refuses production; --verify proves nothing is left')
    .argument('<env-id>')
    .option(
      '--verify',
      'query Azure Resource Graph and Cloudflare for anything still carrying the env-id; fail if found',
    )
    .option(
      '--require-cloudflare',
      'fail (instead of warn) when Cloudflare credentials are missing',
    )
    .option(
      '--delete-orphans',
      'ephemeral only: delete the resource group directly when Terraform state is missing',
    )
    .action(
      action(
        async (
          context,
          envId: string,
          options: { verify?: boolean; requireCloudflare?: boolean; deleteOrphans?: boolean },
        ) =>
          envDown(context, envId, {
            ...(options.verify ? { verify: true } : {}),
            ...(options.requireCloudflare ? { requireCloudflare: true } : {}),
            ...(options.deleteOrphans ? { deleteOrphans: true } : {}),
          }),
      ),
    );

  // ---- customers -----------------------------------------------------------------------------
  program
    .command('customer:new')
    .description(
      'scaffold a new customer instance (config, environments, Terraform roots, .sold/base-version)',
    )
    .argument('<name>', 'customer slug: 3-12 lowercase alphanumerics')
    .option('--dir <path>', 'target directory (default: ../sold-<name>)')
    .option(
      '--base-version <version>',
      'Base version to pin (default: .sold/base-version of this repo)',
    )
    .option('--display-name <name>', 'business name')
    .option('--upstream <url>', 'Base repository URL recorded in .sold/instance.json')
    .action(
      action(
        async (
          context,
          name: string,
          options: { dir?: string; baseVersion?: string; displayName?: string; upstream?: string },
        ) => {
          await customerNew(context, {
            name,
            ...(options.dir ? { dir: options.dir } : {}),
            ...(options.baseVersion ? { baseVersion: options.baseVersion } : {}),
            ...(options.displayName ? { displayName: options.displayName } : {}),
            ...(options.upstream ? { upstream: options.upstream } : {}),
          });
        },
      ),
    );

  // ---- users ---------------------------------------------------------------------------------
  program
    .command('user:create-owner')
    .description('create (or re-enable) an owner account; prints a generated password once')
    .requiredOption('--email <email>', 'owner email address')
    .option('--name <name>', 'display name')
    .action(
      action(async (context, options: { email: string; name?: string }) => {
        await userCreateOwner(context, options);
      }),
    );

  // ---- reporting -----------------------------------------------------------------------------
  program
    .command('reporting:enable-login')
    .description('set the login password of the read-only reporting role from GRAFANA_DB_PASSWORD')
    .action(
      action(async (context) => {
        await reportingEnableLogin(context);
      }),
    );

  // ---- themes --------------------------------------------------------------------------------
  program
    .command('theme:new')
    .description('scaffold a storefront theme (extends the default theme) from themes/_template')
    .argument('<name>', 'kebab-case theme name (2-31 chars)')
    .option('--title <text>', 'one-line description')
    .action(
      action(async (context, name: string, options: { title?: string }) => {
        await themeNew(context, { name, ...(options.title ? { title: options.title } : {}) });
      }),
    );

  program
    .command('theme:list')
    .description('list available themes; the active one is marked')
    .action(
      action(async (context) => {
        await themeList(context);
      }),
    );

  // ---- extensions ----------------------------------------------------------------------------
  program
    .command('ext:new')
    .description('scaffold a working extension from extensions/_template')
    .argument('<name>', 'kebab-case extension name (2-31 chars)')
    .option('--title <text>', 'one-line description')
    .action(
      action(async (context, name: string, options: { title?: string }) => {
        await extNew(context, { name, ...(options.title ? { title: options.title } : {}) });
      }),
    );

  program
    .command('ext:sync')
    .description(
      'generate the static extension registry the web app and worker import (from sold.config.ts)',
    )
    .option('--out <path>', 'output file, relative to the repository root')
    .action(
      action(async (context, options: { out?: string }) => {
        await extSync(context, options.out ? { out: options.out } : {});
      }),
    );

  program
    .command('ext:list')
    .description('show the resolved extension load order, or every reason it cannot boot')
    .action(
      action(async (context) => {
        await extList(context);
      }),
    );

  program
    .command('ext:migrate')
    .description('apply extension migrations and lifecycle transitions (the release-pipeline step)')
    .action(
      action(async (context) => {
        await extMigrate(context);
      }),
    );

  program
    .command('ext:docs')
    .description(
      'generate the extension reference from the manifests (docs/instance/extensions.md)',
    )
    .option('--out <path>', 'output file, relative to the repository root')
    .action(
      action(async (context, options: { out?: string }) => {
        await extDocs(context, options.out ? { out: options.out } : {});
      }),
    );

  // ---- upgrades ------------------------------------------------------------------------------
  program
    .command('upgrade:check')
    .description('report available Base releases, tagged changes and extension compatibility')
    .option('--to <version>')
    .option('--upstream <remote>', 'git remote that carries Base tags', 'upstream')
    .option('--no-fetch', 'do not fetch tags first')
    .option('--patch-only')
    .option('--json')
    .option('--strict', 'exit non-zero when an extension is incompatible')
    .action(
      action(
        async (
          context,
          options: {
            to?: string;
            upstream?: string;
            fetch?: boolean;
            patchOnly?: boolean;
            json?: boolean;
            strict?: boolean;
          },
        ) => {
          await upgradeCheck(context, new Git(context.runner, context.cwd), {
            ...(options.to ? { to: options.to } : {}),
            ...(options.upstream ? { upstream: options.upstream } : {}),
            fetch: options.fetch !== false,
            ...(options.patchOnly ? { patchOnly: true } : {}),
            ...(options.json ? { json: true } : {}),
            ...(options.strict ? { strict: true } : {}),
          });
        },
      ),
    );

  program
    .command('upgrade:plan')
    .description(
      'create upgrade/base-v<version>: take upstream Base-owned files, run codemods, write the report',
    )
    .argument('<version>', 'exact Base version, e.g. 1.5.0')
    .option('--patch-only', 'refuse anything but a patch release of the current minor')
    .option('--upstream <remote>', 'git remote that carries Base tags', 'upstream')
    .option('--no-fetch')
    .option('--no-commit', 'leave the changes staged instead of committing')
    .action(
      action(
        async (
          context,
          version: string,
          options: { patchOnly?: boolean; upstream?: string; fetch?: boolean; commit?: boolean },
        ) => {
          await upgradePlan(context, new Git(context.runner, context.cwd), {
            version,
            ...(options.patchOnly ? { patchOnly: true } : {}),
            ...(options.upstream ? { upstream: options.upstream } : {}),
            fetch: options.fetch !== false,
            noCommit: options.commit === false,
          });
        },
      ),
    );

  program
    .command('upgrade:apply')
    .description(
      'run the verification gates on an upgrade branch and (optionally) push it for the PR workflow',
    )
    .option('--skip-gates')
    .option('--push')
    .option('--remote <remote>', 'remote to push to', 'origin')
    .action(
      action(async (context, options: { skipGates?: boolean; push?: boolean; remote?: string }) => {
        await upgradeApply(context, new Git(context.runner, context.cwd), {
          ...(options.skipGates ? { skipGates: true } : {}),
          ...(options.push ? { push: true } : {}),
          ...(options.remote ? { remote: options.remote } : {}),
        });
      }),
    );

  program
    .command('drift:check')
    .description(
      'fail when Base-owned paths changed outside an upgrade/* branch (instance repositories)',
    )
    .option('--base-ref <ref>', 'ref to compare against', 'origin/main')
    .option('--branch <name>', 'branch name (default: GITHUB_HEAD_REF or the current branch)')
    .option('--force', 'run even if .sold/instance.json is missing')
    .action(
      action(async (context, options: { baseRef?: string; branch?: string; force?: boolean }) => {
        await driftCheck(context, new Git(context.runner, context.cwd), {
          ...(options.baseRef ? { baseRef: options.baseRef } : {}),
          ...(options.branch ? { branch: options.branch } : {}),
          ...(options.force ? { force: true } : {}),
        });
      }),
    );

  // ---- releases ------------------------------------------------------------------------------
  program
    .command('promote')
    .description('copy environments/<from>/release.json to <to> (the PR is opened by the workflow)')
    .argument('<from>', 'dev | stage')
    .argument('<to>', 'stage | prod')
    .option('--allow-skip', 'allow dev -> prod (deliberate exception)')
    .option('--allow-downgrade', 'allow promoting an older release (rollback)')
    .action(
      action(
        async (
          context,
          from: string,
          to: string,
          options: { allowSkip?: boolean; allowDowngrade?: boolean },
        ) => {
          await promote(context, {
            from,
            to,
            ...(options.allowSkip ? { allowSkip: true } : {}),
            ...(options.allowDowngrade ? { allowDowngrade: true } : {}),
          });
        },
      ),
    );

  program
    .command('release:stamp')
    .description('record a fresh build in environments/dev/release.json (used after `build once`)')
    .requiredOption('--image-digest <digest>', 'web image digest, sha256:<64 hex>')
    .option('--worker-image-digest <digest>')
    .option('--migrate-image-digest <digest>')
    .option('--base-version <version>')
    .option('--build <n>', 'instance build number (default: previous + 1)', (v) =>
      Number.parseInt(v, 10),
    )
    .action(
      action(
        async (
          context,
          options: {
            imageDigest: string;
            workerImageDigest?: string;
            migrateImageDigest?: string;
            baseVersion?: string;
            build?: number;
          },
        ) => {
          await stampRelease(context, {
            imageDigest: options.imageDigest,
            ...(options.workerImageDigest ? { workerImageDigest: options.workerImageDigest } : {}),
            ...(options.migrateImageDigest
              ? { migrateImageDigest: options.migrateImageDigest }
              : {}),
            ...(options.baseVersion ? { baseVersion: options.baseVersion } : {}),
            ...(typeof options.build === 'number' ? { instanceBuild: options.build } : {}),
          });
        },
      ),
    );

  program
    .command('release:deploy')
    .description(
      'deploy environments/<env>/release.json: migrate first, then canary with SLO checks and auto-rollback',
    )
    .argument('<env>', 'dev | stage | prod (prod only from the gated release job)')
    .option(
      '--canary <steps>',
      'comma-separated traffic percentages ending in 100 (default 10,50,100 in stage/prod)',
    )
    .option('--soak <duration>', 'soak time between canary steps', '5m')
    .option(
      '--previous-build <n>',
      'instance build serving traffic now (default: discovered from Azure)',
      (v) => Number.parseInt(v, 10),
    )
    .option('--skip-migration')
    .option(
      '--freeze-override <reason>',
      'emergency override of the production deploy freeze (min 10 chars, logged)',
    )
    .action(
      action(
        async (
          context,
          env: string,
          options: {
            canary?: string;
            soak?: string;
            previousBuild?: number;
            skipMigration?: boolean;
            freezeOverride?: string;
          },
        ) => {
          await releaseDeploy(context, {
            environment: env,
            ...(options.canary
              ? { canarySteps: options.canary.split(',').map((s) => Number.parseInt(s.trim(), 10)) }
              : {}),
            ...(options.soak ? { soakMs: parseTtl(options.soak) } : {}),
            ...(typeof options.previousBuild === 'number'
              ? { previousBuild: options.previousBuild }
              : {}),
            ...(options.skipMigration ? { skipMigration: true } : {}),
            ...(options.freezeOverride ? { freezeOverride: options.freezeOverride } : {}),
          });
        },
      ),
    );

  program
    .command('release:freeze-check')
    .description(
      'fail (exit 4) when production deploys are frozen (SOLD_DEPLOY_FREEZE or environments/prod/freeze.json)',
    )
    .option('--override <reason>', 'emergency override reason (min 10 chars)')
    .action(
      action(async (context, options: { override?: string }) => {
        await checkDeployFreeze(context, options.override);
      }),
    );

  program
    .command('release:version')
    .description(
      'print the version identifier <base-version>+<customer>.<instance-build> of an environment',
    )
    .argument('<env>', 'dev | stage | prod')
    .action(
      action(async (context, env: string) => {
        const release = await readRelease(context.cwd, env);
        if (!release) throw new CliError(`environments/${env}/release.json does not exist`);
        const { customer } = await context.loadInstanceConfig(context.cwd);
        context.out.info(formatVersionId(customer, release));
      }),
    );

  // ---- data / content (Phase 0 stubs) ---------------------------------------------------------
  program
    .command('data:snapshot')
    .description('snapshot a database (stub: not implemented in Phase 0)')
    .option('--anonymise')
    .action(
      action(async (context) =>
        notImplemented(
          context,
          'data:snapshot',
          stubDetails['data:snapshot'].phase,
          stubDetails['data:snapshot'].detail,
        ),
      ),
    );
  program
    .command('content:export')
    .description('export content (stub: not implemented in Phase 0)')
    .action(
      action(async (context) =>
        notImplemented(
          context,
          'content:export',
          stubDetails['content:export'].phase,
          stubDetails['content:export'].detail,
        ),
      ),
    );
  program
    .command('content:import')
    .description('import content (stub: not implemented in Phase 0)')
    .action(
      action(async (context) =>
        notImplemented(
          context,
          'content:import',
          stubDetails['content:import'].phase,
          stubDetails['content:import'].detail,
        ),
      ),
    );

  program.addHelpText(
    'after',
    '\nExit codes: 0 ok, 1 failure, 2 usage, 3 leftovers found, 4 refused by a guard, 5 not implemented, 6 plan has changes.',
  );

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? ExitCode.ok : ExitCode.usage;
    }
    if (ctx) return reportError(ctx, error);
    throw error;
  }
  return exitCode;
}

function reportError(ctx: CliContext, error: unknown): number {
  if (error instanceof CliError) {
    ctx.out.error(error.message);
    return error.exitCode;
  }
  if (error instanceof ZodError) {
    ctx.out.error(
      error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('\n'),
    );
    return ExitCode.usage;
  }
  ctx.out.error(error instanceof Error ? error.message : String(error));
  return ExitCode.failure;
}
