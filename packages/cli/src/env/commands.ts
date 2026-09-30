import type { CliContext } from '../lib/context';
import { CliError, ExitCode } from '../lib/errors';
import { writeFile } from 'node:fs/promises';
import { readExecutionName } from '../lib/az';
import { runStep, type Step } from '../lib/steps';
import {
  customerSchema,
  ephemeralEnvironmentName,
  isEphemeralEnvironment,
  makeEnvId,
  parseEnvId,
  type ParsedEnvId,
} from './ids';
import {
  isDeployProfile,
  isProduction,
  PROFILE_INFO,
  profileOfEnvironment,
  type DeployProfile,
} from './profiles';
import {
  DEFAULT_TTL_HOURS,
  DEFAULT_TTL_LIMITS,
  computeExpiresAt,
  extendExpiry,
  formatRemaining,
  isExpired,
  parseTtl,
  validateTtl,
} from './ttl';
import {
  applyStep,
  destroyStep,
  ephemeralVarArgs,
  initStep,
  outputStep,
  parseInputsOutput,
  planStep,
  showPlanStep,
  type EphemeralInputs,
  type TerraformTarget,
} from './terraform';
import { describeVerifyPlan, remediationFor, verifyEnvironmentRemoved } from './verify';
import type { EnvironmentSummary } from './inventory';
import { versionIdSchema } from '../release/schemas';

/** Default cap on simultaneously existing ephemeral environments per customer. */
export const DEFAULT_MAX_CONCURRENT_EPHEMERAL = 5;

const IMAGE_REF = /^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/;
const OWNER = /^[A-Za-z0-9._@+-]{2,64}$/;

function terraformBinary(ctx: CliContext): string {
  return ctx.env['SOLD_TERRAFORM_BIN'] ?? 'terraform';
}

async function makeTarget(
  ctx: CliContext,
  envId: string,
  profileOverride?: DeployProfile,
): Promise<TerraformTarget> {
  const parsed = parseEnvId(envId);
  const config = await ctx.loadInstanceConfig(ctx.cwd);
  return {
    cwd: ctx.cwd,
    parsed,
    profile: profileOverride ?? profileOfEnvironment(parsed.environment),
    tier: config.tier,
    binary: terraformBinary(ctx),
  };
}

/**
 * Previews get a hostname under the customer's preview domain when Cloudflare is configured
 * (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ZONE_ID, SOLD_PREVIEW_DOMAIN); otherwise the edge is skipped.
 */
function previewEdge(ctx: CliContext, envId: string): EphemeralInputs['cloudflare'] {
  const accountId = ctx.env['CLOUDFLARE_ACCOUNT_ID'];
  const zoneId = ctx.env['CLOUDFLARE_ZONE_ID'];
  const domain = ctx.env['SOLD_PREVIEW_DOMAIN'];
  if (!accountId || !zoneId || !domain) return null;
  return { enabled: true, account_id: accountId, zone_id: zoneId, hostname: `${envId}.${domain}` };
}

function resourceGroupOf(envId: string): string {
  return `rg-sold-${envId}`;
}

function refuseProduction(action: string, reasons: string[]): never {
  throw new CliError(
    `refusing to ${action}: this is production (${reasons.join('; ')}). ` +
      'Production changes only through a promotion PR (release.json) and the gated `prod` workflow.',
    ExitCode.refused,
  );
}

async function guardNotProduction(
  ctx: CliContext,
  envId: string,
  action: string,
  summary?: EnvironmentSummary,
): Promise<void> {
  const verdict = await isProduction({ cwd: ctx.cwd, envId, taggedProfile: summary?.profile });
  if (verdict.prod) refuseProduction(action, verdict.reasons);
}

async function lookupSummary(
  ctx: CliContext,
  envId: string,
): Promise<EnvironmentSummary | undefined> {
  try {
    return (await ctx.azure.listEnvironments()).find((e) => e.envId === envId);
  } catch (error) {
    if (ctx.dryRun) {
      ctx.out.warn(
        `could not query Azure for ${envId} (dry-run continues): ${(error as Error).message}`,
      );
      return undefined;
    }
    throw new CliError(`could not query Azure for ${envId}: ${(error as Error).message}`);
  }
}

/** Reads the ephemeral inputs back from Terraform state (`output inputs`). */
async function readInputs(
  ctx: CliContext,
  target: TerraformTarget,
): Promise<EphemeralInputs | undefined> {
  if (ctx.dryRun) {
    await runStep(ctx, outputStep(target, 'inputs', true));
    return undefined;
  }
  const outcome = await runStep(ctx, outputStep(target, 'inputs', true));
  if (outcome.result?.code !== 0) return undefined;
  return parseInputsOutput(outcome.result.stdout);
}

async function readRaw(
  ctx: CliContext,
  target: TerraformTarget,
  name: string,
): Promise<string | undefined> {
  const outcome = await runStep(ctx, outputStep(target, name, false));
  if (outcome.skipped || outcome.result?.code !== 0) return undefined;
  const value = outcome.result.stdout.trim();
  return value === '' ? undefined : value;
}

// ------------------------------------------------------------------------------------------------
// env:up
// ------------------------------------------------------------------------------------------------

export interface EnvUpOptions {
  customer: string;
  env: string;
  profile?: string;
  branch?: string;
  ttl?: string;
  seed?: string;
  image?: string;
  workerImage?: string;
  migrateImage?: string;
  releaseVersion?: string;
  owner?: string;
  maxConcurrent?: number;
  waitForMigration?: boolean;
}

export interface EnvUpPlan {
  envId: string;
  environment: string;
  profile: DeployProfile;
  expiresAt: string;
}

export async function envUp(ctx: CliContext, options: EnvUpOptions): Promise<EnvUpPlan> {
  const customer = customerSchema.safeParse(options.customer);
  if (!customer.success)
    throw new CliError(customer.error.issues[0]?.message ?? 'invalid customer', ExitCode.usage);

  const profileName = options.profile ?? 'ephemeral';
  if (!isDeployProfile(profileName)) {
    throw new CliError(
      `unknown profile '${profileName}': use ephemeral, dev or stage`,
      ExitCode.usage,
    );
  }
  if (!PROFILE_INFO[profileName].cliManaged) {
    throw new CliError(
      'env:up never touches production. Production changes only through a promotion PR (release.json) and the ' +
        'gated `prod` workflow.',
      ExitCode.refused,
    );
  }
  const profile: DeployProfile = profileName;

  let environment: string;
  if (profile === 'ephemeral') {
    const label = options.branch ?? options.env;
    environment = isEphemeralEnvironment(label) ? label : ephemeralEnvironmentName(label);
  } else {
    if (options.env !== profile) {
      throw new CliError(
        `the ${profile} environment is named '${profile}', not '${options.env}'`,
        ExitCode.usage,
      );
    }
    if (options.ttl)
      throw new CliError(`--ttl only applies to ephemeral environments`, ExitCode.usage);
    environment = profile;
  }
  const envId = makeEnvId(options.customer, environment);
  const now = ctx.now();

  let expiresAt = 'never';
  if (profile === 'ephemeral') {
    const ttlMs = validateTtl(parseTtl(options.ttl ?? `${DEFAULT_TTL_HOURS}h`));
    expiresAt = computeExpiresAt(now, ttlMs);
  }

  const owner = options.owner ?? ctx.env['GITHUB_ACTOR'] ?? ctx.env['USER'] ?? '';
  if (!OWNER.test(owner)) {
    throw new CliError(
      'cannot determine the owner: pass --owner <github-handle-or-email>',
      ExitCode.usage,
    );
  }

  // Guard: per-customer cap on concurrent ephemeral environments. Re-running `env:up` for an
  // environment that already exists is an update and does not count against the cap.
  if (profile === 'ephemeral') {
    const max = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_EPHEMERAL;
    let existing: EnvironmentSummary[] = [];
    try {
      existing = await ctx.azure.listEnvironments();
    } catch (error) {
      if (!ctx.dryRun)
        throw new CliError(`cannot check the concurrency guard: ${(error as Error).message}`);
      ctx.out.warn(`concurrency guard skipped in dry-run: ${(error as Error).message}`);
    }
    const others = existing.filter(
      (e) => e.customer === options.customer && e.profile === 'ephemeral' && e.envId !== envId,
    );
    if (others.length >= max) {
      throw new CliError(
        `customer '${options.customer}' already has ${others.length} ephemeral environments (max ${max}). ` +
          `Destroy one first (sold env:down <env-id>) or extend limits deliberately:\n` +
          others
            .map(
              (e) => `  ${e.envId}  owner=${e.owner}  expires ${formatRemaining(e.expiresAt, now)}`,
            )
            .join('\n'),
        ExitCode.refused,
      );
    }
  }

  const target: TerraformTarget = { ...(await makeTarget(ctx, envId, profile)) };
  const steps: Step[] = [initStep(target)];

  if (profile === 'ephemeral') {
    if (!options.image || !IMAGE_REF.test(options.image)) {
      throw new CliError(
        '--image <registry>/sold/web@sha256:<digest> is required (images are promoted by digest, never by tag)',
        ExitCode.usage,
      );
    }
    for (const [flag, value] of [
      ['--worker-image', options.workerImage],
      ['--migrate-image', options.migrateImage],
    ] as const) {
      if (value && !IMAGE_REF.test(value))
        throw new CliError(`${flag} must be pinned by digest`, ExitCode.usage);
    }
    const version = versionIdSchema.safeParse(options.releaseVersion);
    if (!version.success || version.data.customer !== options.customer) {
      throw new CliError(
        `--release-version must look like <base-version>+${options.customer}.<instance-build>`,
        ExitCode.usage,
      );
    }
    const inputs: EphemeralInputs = {
      env_id: envId,
      environment,
      owner,
      expires_at: expiresAt,
      release_version: options.releaseVersion ?? '',
      image: options.image,
      worker_image: options.workerImage ?? null,
      migrate_image: options.migrateImage ?? null,
      cloudflare: previewEdge(ctx, envId),
    };
    steps.push(
      applyStep(target, ephemeralVarArgs(inputs), `create/update ${envId} (expires ${expiresAt})`),
    );
  } else {
    steps.push(applyStep(target, [], `create/update ${envId}`));
  }

  for (const step of steps) await runStep(ctx, step);

  const url = await readRaw(ctx, target, 'url');
  const rg = resourceGroupOf(envId);
  await runMigration(ctx, rg, options.waitForMigration ?? true, options.seed);

  if (ctx.dryRun) {
    ctx.out.info(
      `[dry-run] ${envId} would be ready${url ? ` at ${url}` : ''}; expires ${expiresAt}`,
    );
  } else {
    ctx.out.info(`ready: ${envId}${url ? `  ${url}` : ''}  expires ${expiresAt}`);
  }
  return { envId, environment, profile, expiresAt };
}

async function runMigration(
  ctx: CliContext,
  rg: string,
  wait: boolean,
  seed?: string,
): Promise<void> {
  const startArgs = [
    'containerapp',
    'job',
    'start',
    '--name',
    'migrate',
    '--resource-group',
    rg,
    '-o',
    'json',
  ];
  if (seed) {
    // Seeds are demo data for non-production only. The migrate image seeds when SOLD_SEED is set
    // (contract with the Phase 0 migrate image: PENDING(phase-0)).
    startArgs.push('--env-vars', `SOLD_SEED=${seed}`);
  }
  const started = await runStep(ctx, {
    description: `run database migrations${seed ? ` and seed '${seed}'` : ''} (job 'migrate')`,
    command: 'az',
    args: startArgs,
  });
  if (started.skipped || !wait) return;
  const execution = readExecutionName(started.result?.stdout);
  if (!execution)
    throw new CliError(
      'could not read the migration execution name from `az containerapp job start`',
    );
  await waitForJob(ctx, rg, execution);
}

async function waitForJob(ctx: CliContext, rg: string, execution: string): Promise<void> {
  const deadline = ctx.now().getTime() + 15 * 60_000;
  for (;;) {
    const outcome = await runStep(ctx, {
      description: `check migration execution ${execution}`,
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
    });
    const status = outcome.result?.stdout.trim() ?? '';
    if (status === 'Succeeded') return;
    if (['Failed', 'Stopped', 'Degraded'].includes(status)) {
      throw new CliError(`migration execution ${execution} ended with status ${status}`);
    }
    if (ctx.now().getTime() > deadline)
      throw new CliError(`migration execution ${execution} did not finish in 15 minutes`);
    await ctx.sleep(10_000);
  }
}

// ------------------------------------------------------------------------------------------------
// env:id
// ------------------------------------------------------------------------------------------------

/** Prints the env-id `env:up` would use, so workflows can find (and destroy) a preview from its branch. */
export async function envId(
  ctx: CliContext,
  options: { customer?: string; branch?: string; env?: string },
): Promise<string> {
  const customer = options.customer ?? (await ctx.loadInstanceConfig(ctx.cwd)).customer;
  const label = options.branch ?? options.env;
  if (!label)
    throw new CliError('pass --branch <name> (ephemeral) or --env dev|stage|prod', ExitCode.usage);
  let environment: string;
  if (options.branch) {
    environment = ephemeralEnvironmentName(options.branch);
  } else {
    if (!isEphemeralEnvironment(label)) profileOfEnvironment(label); // throws for names that are not on the ladder
    environment = label;
  }
  const id = makeEnvId(customer, environment);
  ctx.out.info(id);
  return id;
}

// ------------------------------------------------------------------------------------------------
// env:plan (read-only: safe for every environment, including production)
// ------------------------------------------------------------------------------------------------

export interface EnvPlanOptions {
  /** Write the plan as JSON (`terraform show -json`) here, for the tag policy check. */
  jsonOut?: string;
  /** Do not take the state lock (read-only identities cannot; drift detection). */
  noLock?: boolean;
}

/** Exit 0: no changes. Exit 6 (ExitCode.changes): the plan has changes. Anything else is an error. */
export async function envPlan(
  ctx: CliContext,
  envId: string,
  options: EnvPlanOptions = {},
): Promise<number> {
  const parsed = parseEnvId(envId);
  if (isEphemeralEnvironment(parsed.environment)) {
    throw new CliError(
      'env:plan is for dev, stage and prod; ephemeral environments are created from scratch',
      ExitCode.usage,
    );
  }
  const target = await makeTarget(ctx, envId);
  await runStep(ctx, initStep(target));
  const plan = await runStep(ctx, {
    ...planStep(target, options.noLock === true),
    allowFailure: true,
  });
  if (plan.skipped) return ExitCode.ok;
  const code = plan.result?.code ?? 1;
  if (code !== 0 && code !== 2) {
    throw new CliError(
      `terraform plan failed (exit ${code})\n${(plan.result?.stderr ?? '').trim().split('\n').slice(-8).join('\n')}`,
    );
  }
  if (options.jsonOut) {
    const shown = await runStep(ctx, showPlanStep(target));
    await writeFile(options.jsonOut, shown.result?.stdout ?? '');
    ctx.out.info(`wrote ${options.jsonOut}`);
  }
  ctx.out.info(
    code === 0
      ? `${envId}: no changes`
      : `${envId}: the plan has changes (drift or a pending change)`,
  );
  return code === 0 ? ExitCode.ok : ExitCode.changes;
}

// ------------------------------------------------------------------------------------------------
// env:pause / env:resume
// ------------------------------------------------------------------------------------------------

async function postgresState(ctx: CliContext, rg: string, server: string): Promise<string> {
  const outcome = await runStep(ctx, {
    description: `read PostgreSQL server state`,
    command: 'az',
    args: [
      'postgres',
      'flexible-server',
      'show',
      '--resource-group',
      rg,
      '--name',
      server,
      '--query',
      'state',
      '-o',
      'tsv',
    ],
    readOnly: true,
  });
  return outcome.result?.stdout.trim() ?? '';
}

export async function envPause(ctx: CliContext, envId: string): Promise<void> {
  const summary = await lookupSummary(ctx, envId);
  await guardNotProduction(ctx, envId, 'pause', summary);
  const target = await makeTarget(ctx, envId);
  const rg = resourceGroupOf(envId);

  await runStep(ctx, initStep(target));
  const inputs = isEphemeralEnvironment(target.parsed.environment)
    ? await readInputs(ctx, target)
    : undefined;
  if (isEphemeralEnvironment(target.parsed.environment) && !inputs && !ctx.dryRun) {
    throw new CliError(`no Terraform state found for ${envId}; nothing to pause`);
  }
  // Web and worker scale to zero through Terraform (`paused = true`), so it is not drift.
  await runStep(
    ctx,
    applyStep(
      target,
      [...(inputs ? ephemeralVarArgs(inputs) : []), '-var=paused=true'],
      `scale ${envId} to zero`,
    ),
  );
  const server = (await readRaw(ctx, target, 'postgres_server_name')) ?? '<postgres-server-name>';
  if (ctx.dryRun) {
    await postgresState(ctx, rg, server);
  } else if ((await postgresState(ctx, rg, server)) === 'Stopped') {
    ctx.out.info('PostgreSQL is already stopped');
    return;
  }
  // Azure restarts a stopped flexible server after 7 days, so the nightly workflow re-runs env:pause.
  await runStep(ctx, {
    description: 'stop PostgreSQL (compute billing stops; storage and backups still bill)',
    command: 'az',
    args: ['postgres', 'flexible-server', 'stop', '--resource-group', rg, '--name', server],
  });
  ctx.out.info(
    `${envId} paused. Note: Azure Managed Redis (stage/prod) cannot be stopped and keeps billing while paused.`,
  );
}

export async function envResume(ctx: CliContext, envId: string): Promise<void> {
  const summary = await lookupSummary(ctx, envId);
  await guardNotProduction(ctx, envId, 'resume', summary);
  const target = await makeTarget(ctx, envId);
  const rg = resourceGroupOf(envId);

  await runStep(ctx, initStep(target));
  const inputs = isEphemeralEnvironment(target.parsed.environment)
    ? await readInputs(ctx, target)
    : undefined;
  if (isEphemeralEnvironment(target.parsed.environment) && !inputs && !ctx.dryRun) {
    throw new CliError(`no Terraform state found for ${envId}; nothing to resume`);
  }
  const server = (await readRaw(ctx, target, 'postgres_server_name')) ?? '<postgres-server-name>';
  if (ctx.dryRun || (await postgresState(ctx, rg, server)) !== 'Ready') {
    await runStep(ctx, {
      description: 'start PostgreSQL',
      command: 'az',
      args: ['postgres', 'flexible-server', 'start', '--resource-group', rg, '--name', server],
    });
  }
  await runStep(
    ctx,
    applyStep(
      target,
      [...(inputs ? ephemeralVarArgs(inputs) : []), '-var=paused=false'],
      `restore replicas of ${envId}`,
    ),
  );
  ctx.out.info(`${envId} resumed`);
}

// ------------------------------------------------------------------------------------------------
// env:extend
// ------------------------------------------------------------------------------------------------

export async function envExtend(ctx: CliContext, envId: string, ttl: string): Promise<string> {
  const summary = await lookupSummary(ctx, envId);
  if (!summary && !ctx.dryRun)
    throw new CliError(`no environment with env-id ${envId} found in Azure`);
  await guardNotProduction(ctx, envId, 'extend', summary);
  const parsed = parseEnvId(envId);
  if (!isEphemeralEnvironment(parsed.environment)) {
    throw new CliError(
      `${envId} is not ephemeral; only ephemeral environments expire`,
      ExitCode.refused,
    );
  }
  const now = ctx.now();
  const next = extendExpiry(
    summary?.expiresAt ?? computeExpiresAt(now, 0),
    now,
    parseTtl(ttl),
    DEFAULT_TTL_LIMITS,
  );

  const target = await makeTarget(ctx, envId, 'ephemeral');
  await runStep(ctx, initStep(target));
  const inputs = await readInputs(ctx, target);
  if (!inputs && !ctx.dryRun) throw new CliError(`no Terraform state found for ${envId}`);
  const applied: EphemeralInputs = inputs
    ? { ...inputs, expires_at: next }
    : {
        env_id: envId,
        environment: parsed.environment,
        owner: '<owner>',
        expires_at: next,
        release_version: '<release-version>',
        image: '<image>',
      };
  await runStep(
    ctx,
    applyStep(target, ephemeralVarArgs(applied), `set expires-at of ${envId} to ${next}`),
  );
  ctx.out.info(`${envId} now expires ${next}`);
  return next;
}

// ------------------------------------------------------------------------------------------------
// env:list / env:cost
// ------------------------------------------------------------------------------------------------

export interface EnvListOptions {
  customer?: string;
  expired?: boolean;
  /** Only environments expiring within this many ms (warning window). */
  expiringWithinMs?: number;
  json?: boolean;
}

export async function envList(
  ctx: CliContext,
  options: EnvListOptions = {},
): Promise<EnvironmentSummary[]> {
  const now = ctx.now();
  let envs = await ctx.azure.listEnvironments();
  if (options.customer) envs = envs.filter((e) => e.customer === options.customer);
  if (options.expired) envs = envs.filter((e) => isExpired(e.expiresAt, now));
  if (options.expiringWithinMs !== undefined) {
    const within = options.expiringWithinMs;
    envs = envs.filter((e) => {
      if (e.expiresAt === 'never' || isExpired(e.expiresAt, now)) return false;
      return Date.parse(e.expiresAt) - now.getTime() <= within;
    });
  }
  envs.sort((a, b) => a.envId.localeCompare(b.envId));
  if (options.json) {
    ctx.out.info(JSON.stringify(envs, null, 2));
    return envs;
  }
  if (envs.length === 0) {
    ctx.out.info('no environments');
    return envs;
  }
  const rows = envs.map((e) => [
    e.envId,
    e.profile,
    e.owner,
    formatRemaining(e.expiresAt, now),
    e.release,
  ]);
  const header = ['ENV-ID', 'PROFILE', 'OWNER', 'EXPIRES', 'RELEASE'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (r: string[]): string =>
    r
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  ctx.out.info(fmt(header));
  for (const r of rows) ctx.out.info(fmt(r));
  return envs;
}

export interface CostRow {
  envId: string;
  monthToDate: number | undefined;
  currency: string | undefined;
  budget: number | undefined;
}

/**
 * Parses the Cost Management Query API response (`properties.columns` + `properties.rows`).
 * Response shape: UNVERIFIED against a live subscription (ADR-0003).
 */
export function parseCostQuery(
  stdout: string,
): { cost: number; currency: string | undefined } | undefined {
  try {
    const body = JSON.parse(stdout) as {
      properties?: { columns?: { name?: string }[]; rows?: unknown[][] };
    };
    const columns = body.properties?.columns ?? [];
    const rows = body.properties?.rows ?? [];
    if (rows.length === 0) return { cost: 0, currency: undefined };
    const costIndex = columns.findIndex((c) => /cost/i.test(c.name ?? ''));
    const currencyIndex = columns.findIndex((c) => /currency/i.test(c.name ?? ''));
    let total = 0;
    let currency: string | undefined;
    for (const row of rows) {
      const cost = Number(row[costIndex < 0 ? 0 : costIndex]);
      if (Number.isNaN(cost)) return undefined;
      total += cost;
      const c = row[currencyIndex];
      if (typeof c === 'string') currency = c;
    }
    return { cost: total, currency };
  } catch {
    return undefined;
  }
}

export async function envCost(
  ctx: CliContext,
  options: { envId?: string; json?: boolean } = {},
): Promise<CostRow[]> {
  let envs = await ctx.azure.listEnvironments();
  if (options.envId) envs = envs.filter((e) => e.envId === options.envId);
  if (options.envId && envs.length === 0 && !ctx.dryRun)
    throw new CliError(`no environment ${options.envId} found`);
  const rows: CostRow[] = [];
  for (const env of envs) {
    const scope = `/subscriptions/${env.subscriptionId}/resourceGroups/${env.resourceGroup}`;
    const body = JSON.stringify({
      type: 'ActualCost',
      timeframe: 'MonthToDate',
      dataset: {
        granularity: 'None',
        aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
      },
    });
    const outcome = await runStep(ctx, {
      description: `month-to-date actual cost of ${env.envId}`,
      command: 'az',
      args: [
        'rest',
        '--method',
        'post',
        '--url',
        `https://management.azure.com${scope}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`,
        '--body',
        body,
        '-o',
        'json',
      ],
      readOnly: true,
      allowFailure: true,
    });
    const parsed =
      outcome.result && outcome.result.code === 0
        ? parseCostQuery(outcome.result.stdout)
        : undefined;
    rows.push({
      envId: env.envId,
      monthToDate: parsed?.cost,
      currency: parsed?.currency,
      budget: undefined,
    });
  }
  if (ctx.dryRun) return rows;
  if (options.json) {
    ctx.out.info(JSON.stringify(rows, null, 2));
  } else {
    for (const r of rows) {
      ctx.out.info(
        `${r.envId.padEnd(34)} ${r.monthToDate === undefined ? 'unavailable' : `${r.monthToDate.toFixed(2)} ${r.currency ?? ''}`.trim()}`,
      );
    }
  }
  return rows;
}

// ------------------------------------------------------------------------------------------------
// env:down
// ------------------------------------------------------------------------------------------------

export interface EnvDownOptions {
  verify?: boolean;
  requireCloudflare?: boolean;
  /** When Terraform state is gone but the resource group lingers (ephemeral only), delete it directly. */
  deleteOrphans?: boolean;
}

export async function envDown(
  ctx: CliContext,
  envId: string,
  options: EnvDownOptions = {},
): Promise<number> {
  const parsed: ParsedEnvId = parseEnvId(envId);
  const summary = await lookupSummary(ctx, envId);
  await guardNotProduction(ctx, envId, 'destroy', summary);
  if (
    !isEphemeralEnvironment(parsed.environment) &&
    !PROFILE_INFO[profileOfEnvironment(parsed.environment)].cliManaged
  ) {
    throw new CliError('production is never destroyed by the CLI', ExitCode.refused);
  }

  const target = await makeTarget(ctx, envId);
  const ephemeral = isEphemeralEnvironment(parsed.environment);
  await runStep(ctx, initStep(target));
  const inputs = ephemeral ? await readInputs(ctx, target) : undefined;

  if (ephemeral && !inputs && !ctx.dryRun) {
    ctx.out.warn(`no Terraform state for ${envId}: it may already be destroyed`);
    const leftoversNow = await ctx.azure.findResources(envId);
    if (leftoversNow.length > 0 && options.deleteOrphans) {
      if (summary?.profile !== 'ephemeral') {
        throw new CliError(
          `refusing to delete orphans of ${envId}: its resource group is not tagged sold:profile=ephemeral`,
          ExitCode.refused,
        );
      }
      await runStep(ctx, {
        description: `delete orphaned resource group ${summary.resourceGroup}`,
        command: 'az',
        args: ['group', 'delete', '--name', summary.resourceGroup, '--yes'],
      });
    }
  } else {
    await runStep(ctx, destroyStep(target, inputs ? ephemeralVarArgs(inputs) : []));
  }

  if (!options.verify) {
    ctx.out.info(`${envId} destroyed (not verified; pass --verify to prove nothing is left)`);
    return ExitCode.ok;
  }

  if (ctx.dryRun) {
    ctx.out.info('[dry-run] verification would run these queries:');
    for (const q of describeVerifyPlan(ctx, envId)) ctx.out.info(`[dry-run]   ${q}`);
    return ExitCode.ok;
  }

  const result = await verifyEnvironmentRemoved(ctx, envId, {
    requireCloudflare: options.requireCloudflare ?? false,
  });
  for (const w of result.warnings) ctx.out.warn(w);
  if (!result.ok) {
    ctx.out.error(
      `env:down --verify FAILED: ${result.leftovers.length} leftover(s) still carry or are named for ${envId}:`,
    );
    for (const item of result.leftovers) {
      const fix = remediationFor(item);
      ctx.out.error(
        `  - [${item.source}] ${item.kind} ${item.name || item.id}${fix ? `  (${fix})` : ''}`,
      );
    }
    return ExitCode.leftovers;
  }
  ctx.out.info(`verified: nothing carrying sold:env-id=${envId} remains in Azure or Cloudflare`);
  return ExitCode.ok;
}
