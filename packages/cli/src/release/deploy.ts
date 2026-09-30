import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CliContext } from '../lib/context';
import { CliError, ExitCode } from '../lib/errors';
import { readExecutionName } from '../lib/az';
import { runStep } from '../lib/steps';
import { makeEnvId } from '../env/ids';
import { applyStep, initStep, type TerraformTarget } from '../env/terraform';
import { PROFILE_INFO, profilesDir, type DeployProfile } from '../env/profiles';
import { checkDeployFreeze } from './freeze';
import { isLadderEnvironment, readRelease } from './promote';
import { formatVersionId, isPlaceholderDigest } from './schemas';
import { parseTtl } from '../env/ttl';

/** Address of the migrate job inside the composite, used to migrate BEFORE the new revision serves. */
export const MIGRATE_JOB_TARGET =
  'module.environment.module.container_apps.azurerm_container_app_job.migrate';

export interface SloVerdict {
  healthy: boolean;
  detail: string;
}

/** The signal that decides canary progression and rollback. Injectable; the default is a placeholder. */
export interface SloProbe {
  check(input: { subscriptionId: string; resourceGroup: string; since: Date }): Promise<SloVerdict>;
}

/**
 * PLACEHOLDER SLO signal (PENDING(phase-8)): any Azure Monitor alert fired in the environment's resource
 * group since the deploy started (Sev0-Sev2, e.g. the web 5xx and PostgreSQL CPU alerts from
 * azure-observability) counts as a burn. Replace with multi-window SLO burn-rate alerts once the SLOs in
 * docs/scaling.md are measured. Response shape UNVERIFIED against a live subscription.
 */
export class AzureMonitorAlertsProbe implements SloProbe {
  constructor(private readonly ctx: Pick<CliContext, 'runner'>) {}

  async check(input: {
    subscriptionId: string;
    resourceGroup: string;
    since: Date;
  }): Promise<SloVerdict> {
    const url =
      `https://management.azure.com/subscriptions/${input.subscriptionId}/providers/Microsoft.AlertsManagement/alerts` +
      `?api-version=2019-05-05-preview&targetResourceGroup=${input.resourceGroup}&monitorCondition=Fired&timeRange=1d`;
    const result = await this.ctx.runner.run('az', [
      'rest',
      '--method',
      'get',
      '--url',
      url,
      '-o',
      'json',
    ]);
    if (result.code !== 0)
      return {
        healthy: false,
        detail: `alert query failed: ${result.stderr.trim().slice(0, 200)}`,
      };
    try {
      const body = JSON.parse(result.stdout) as {
        value?: {
          name?: string;
          properties?: { essentials?: { severity?: string; startDateTime?: string } };
        }[];
      };
      const fired = (body.value ?? []).filter((a) => {
        const e = a.properties?.essentials;
        return (
          e?.startDateTime !== undefined &&
          Date.parse(e.startDateTime) >= input.since.getTime() &&
          ['Sev0', 'Sev1', 'Sev2'].includes(e.severity ?? '')
        );
      });
      return fired.length === 0
        ? { healthy: true, detail: 'no Sev0-2 alerts fired since the deploy started' }
        : { healthy: false, detail: `alerts fired: ${fired.map((a) => a.name ?? '?').join(', ')}` };
    } catch {
      return { healthy: false, detail: 'unreadable alert response (failing closed)' };
    }
  }
}

export interface DeployOptions {
  environment: string;
  /** Traffic percentages after the 0% start, ascending, ending at 100. Default stage/prod 10,50,100. */
  canarySteps?: number[];
  /** Soak time between steps (default 5m). */
  soakMs?: number;
  previousBuild?: number;
  skipMigration?: boolean;
  freezeOverride?: string;
  slo?: SloProbe;
}

export interface DeployResult {
  envId: string;
  versionId: string;
  revisionSuffix: string;
  strategy: 'canary' | 'migrate-then-apply';
  rolledBack: boolean;
}

async function revisionModeOf(cwd: string, profile: DeployProfile): Promise<'Single' | 'Multiple'> {
  try {
    const text = await readFile(join(profilesDir(cwd), PROFILE_INFO[profile].tfvars), 'utf8');
    const match = /^\s*revision_mode\s*=\s*"(Single|Multiple)"/m.exec(text);
    if (match?.[1] === 'Single' || match?.[1] === 'Multiple') return match[1];
  } catch {
    // fall through to the ladder default
  }
  return profile === 'stage' || profile === 'prod' ? 'Multiple' : 'Single';
}

function parseSuffix(revisionName: string): string | undefined {
  const m = /--([a-z0-9-]+)$/.exec(revisionName);
  return m?.[1];
}

export async function releaseDeploy(
  ctx: CliContext,
  options: DeployOptions,
): Promise<DeployResult> {
  if (!isLadderEnvironment(options.environment)) {
    throw new CliError(
      `release:deploy targets dev, stage or prod; got '${options.environment}'`,
      ExitCode.usage,
    );
  }
  const profile: DeployProfile = options.environment;
  const environment = options.environment;

  if (environment === 'prod') {
    if (ctx.env['GITHUB_ACTIONS'] !== 'true' || ctx.env['SOLD_DEPLOY_APPROVED'] !== 'prod') {
      throw new CliError(
        'production deploys run only from the gated `prod` job of the release workflow (GitHub environment with ' +
          'required reviewers). Nobody changes prod by hand.',
        ExitCode.refused,
      );
    }
    await checkDeployFreeze(ctx, options.freezeOverride);
  }

  const release = await readRelease(ctx.cwd, environment);
  if (!release) throw new CliError(`environments/${environment}/release.json does not exist`);
  if (isPlaceholderDigest(release.imageDigest)) {
    throw new CliError(
      `environments/${environment}/release.json carries the placeholder digest: nothing to deploy`,
      ExitCode.refused,
    );
  }
  const config = await ctx.loadInstanceConfig(ctx.cwd);
  const versionId = formatVersionId(config.customer, release);
  const envId = makeEnvId(config.customer, environment);
  const rg = `rg-sold-${envId}`;
  const revisionSuffix = `b${release.instanceBuild}`;
  const target: TerraformTarget = {
    cwd: ctx.cwd,
    parsed: { envId, customer: config.customer, environment },
    profile,
    tier: config.tier,
    binary: ctx.env['SOLD_TERRAFORM_BIN'] ?? 'terraform',
  };
  const mode = await revisionModeOf(ctx.cwd, profile);
  const steps = options.canarySteps ?? (mode === 'Multiple' ? [10, 50, 100] : []);
  if (
    steps.length > 0 &&
    (steps[steps.length - 1] !== 100 ||
      steps.some((s, i) => s <= 0 || s > 100 || (i > 0 && s <= (steps[i - 1] ?? 0))))
  ) {
    throw new CliError('canary steps must be ascending percentages ending at 100', ExitCode.usage);
  }
  const started = ctx.now();
  ctx.out.info(`deploying ${versionId} to ${envId} (${mode} revision mode)`);

  await runStep(ctx, initStep(target));

  // Which revision currently serves traffic? (Multiple mode only; the canary keeps the rest of the traffic on it.)
  let previous: string | undefined =
    options.previousBuild === undefined ? undefined : `b${options.previousBuild}`;
  if (previous === undefined && mode === 'Multiple')
    previous = await currentRevisionSuffix(ctx, rg, revisionSuffix);

  const canary = mode === 'Multiple' && previous !== undefined && previous !== revisionSuffix;
  const prevArgs =
    previous && previous !== revisionSuffix ? [`-var=previous_revision_suffix=${previous}`] : [];

  if (canary) {
    // The new revision is created with 0% traffic: safe to apply before the schema is expanded.
    await runStep(
      ctx,
      applyStep(
        target,
        ['-var=canary_percent=0', ...prevArgs],
        `create revision ${revisionSuffix} with 0% traffic`,
      ),
    );
  } else {
    // No previous revision to shield users (first deploy or Single mode): expand the schema first, then roll out.
    await runStep(
      ctx,
      applyStep(
        target,
        [`-target=${MIGRATE_JOB_TARGET}`],
        'update infrastructure and the migrate job only',
      ),
    );
  }

  if (!options.skipMigration) await runMigrate(ctx, rg);
  else ctx.out.warn('migration skipped (--skip-migration)');

  if (!canary) {
    await runStep(ctx, applyStep(target, [], `roll out ${revisionSuffix} (all traffic)`));
    if (!ctx.dryRun) await waitRevisionHealthy(ctx, rg, revisionSuffix);
    ctx.out.info(`deployed ${versionId} to ${envId}`);
    return { envId, versionId, revisionSuffix, strategy: 'migrate-then-apply', rolledBack: false };
  }

  if (!ctx.dryRun) await waitRevisionHealthy(ctx, rg, revisionSuffix);
  const slo = options.slo ?? new AzureMonitorAlertsProbe(ctx);
  const soak = options.soakMs ?? parseTtl('5m');
  for (const percent of steps) {
    await runStep(
      ctx,
      applyStep(
        target,
        [`-var=canary_percent=${percent}`, ...prevArgs],
        `send ${percent}% of traffic to ${revisionSuffix}`,
      ),
    );
    if (percent === 100 || ctx.dryRun) continue;
    await ctx.sleep(soak);
    const subscriptionId = await subscriptionOf(ctx);
    const verdict = await slo.check({ subscriptionId, resourceGroup: rg, since: started });
    ctx.out.info(`SLO check at ${percent}%: ${verdict.detail}`);
    if (!verdict.healthy) {
      ctx.out.error(
        `SLO burn detected at ${percent}%: rolling back to ${previous ?? 'the previous revision'}`,
      );
      await runStep(
        ctx,
        applyStep(
          target,
          ['-var=canary_percent=0', ...prevArgs],
          `ROLLBACK: 0% to ${revisionSuffix}, 100% to ${previous ?? 'previous'}`,
        ),
      );
      throw new CliError(
        `canary of ${versionId} rolled back at ${percent}% (${verdict.detail}). Traffic is back on ${previous}. ` +
          'Revert the promotion PR so release.json matches what is serving.',
      );
    }
  }

  if (previous) {
    await runStep(ctx, {
      description: `deactivate the previous revision ${previous}`,
      command: 'az',
      args: [
        'containerapp',
        'revision',
        'deactivate',
        '--name',
        'web',
        '--resource-group',
        rg,
        '--revision',
        `web--${previous}`,
      ],
      allowFailure: true,
    });
  }
  ctx.out.info(`deployed ${versionId} to ${envId}`);
  return { envId, versionId, revisionSuffix, strategy: 'canary', rolledBack: false };
}

async function subscriptionOf(ctx: CliContext): Promise<string> {
  const result = await ctx.runner.run('az', ['account', 'show', '--query', 'id', '-o', 'tsv']);
  return result.stdout.trim();
}

async function currentRevisionSuffix(
  ctx: CliContext,
  rg: string,
  exclude: string,
): Promise<string | undefined> {
  const outcome = await runStep(ctx, {
    description: 'find the revision that currently serves traffic',
    command: 'az',
    args: [
      'containerapp',
      'revision',
      'list',
      '--name',
      'web',
      '--resource-group',
      rg,
      '-o',
      'json',
    ],
    readOnly: true,
    allowFailure: true,
  });
  if (outcome.skipped || outcome.result?.code !== 0) return undefined;
  try {
    const revisions = JSON.parse(outcome.result.stdout) as {
      name?: string;
      properties?: { active?: boolean; trafficWeight?: number };
    }[];
    const serving = revisions
      .filter((r) => r.properties?.active && (r.properties.trafficWeight ?? 0) > 0)
      .sort((a, b) => (b.properties?.trafficWeight ?? 0) - (a.properties?.trafficWeight ?? 0))
      .map((r) => parseSuffix(r.name ?? ''))
      .find((s) => s !== undefined && s !== exclude);
    return serving;
  } catch {
    return undefined;
  }
}

async function runMigrate(ctx: CliContext, rg: string): Promise<void> {
  const started = await runStep(ctx, {
    description: 'run database migrations (job migrate, expand/contract, forward-only)',
    command: 'az',
    args: [
      'containerapp',
      'job',
      'start',
      '--name',
      'migrate',
      '--resource-group',
      rg,
      '-o',
      'json',
    ],
  });
  if (started.skipped) return;
  const execution = readExecutionName(started.result?.stdout);
  if (!execution) throw new CliError('could not read the migration execution name');
  const deadline = ctx.now().getTime() + 20 * 60_000;
  for (;;) {
    const status = (
      await runStep(ctx, {
        description: `check migration ${execution}`,
        command: 'az',
        args: [
          'containerapp',
          'job',
          'execution',
          'show',
          '--name',
          'migrate',
          '--resource-group',
          rg,
          '--job-execution-name',
          execution,
          '--query',
          'properties.status',
          '-o',
          'tsv',
        ],
        readOnly: true,
      })
    ).result?.stdout.trim();
    if (status === 'Succeeded') return;
    if (status === 'Failed' || status === 'Stopped' || status === 'Degraded') {
      throw new CliError(
        `migration ${execution} ended with status ${status}; no traffic was shifted`,
      );
    }
    if (ctx.now().getTime() > deadline)
      throw new CliError(
        `migration ${execution} did not finish in 20 minutes; no traffic was shifted`,
      );
    await ctx.sleep(10_000);
  }
}

async function waitRevisionHealthy(ctx: CliContext, rg: string, suffix: string): Promise<void> {
  const deadline = ctx.now().getTime() + 15 * 60_000;
  for (;;) {
    const outcome = await runStep(ctx, {
      description: `check health of revision web--${suffix}`,
      command: 'az',
      args: [
        'containerapp',
        'revision',
        'show',
        '--name',
        'web',
        '--resource-group',
        rg,
        '--revision',
        `web--${suffix}`,
        '--query',
        'properties.healthState',
        '-o',
        'tsv',
      ],
      readOnly: true,
      allowFailure: true,
    });
    const state = outcome.result?.stdout.trim();
    if (state === 'Healthy') return;
    if (state === 'Unhealthy')
      throw new CliError(`revision web--${suffix} is unhealthy; traffic was not shifted to it`);
    if (ctx.now().getTime() > deadline)
      throw new CliError(`revision web--${suffix} did not become healthy in 15 minutes`);
    await ctx.sleep(10_000);
  }
}
