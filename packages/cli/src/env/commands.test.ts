import { afterEach, describe, expect, it } from 'vitest';
import { CliError, ExitCode } from '../lib/errors';
import type { FakeRunner } from '../testing';
import { cleanup, makeContext, tempDir, writeTree, type TestContext } from '../testing';
import {
  DEFAULT_MAX_CONCURRENT_EPHEMERAL,
  envCost,
  envDown,
  envExtend,
  envList,
  envPause,
  envPlan,
  envResume,
  envUp,
  parseCostQuery,
} from './commands';
import { environmentSummary } from './fakes';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const IMAGE = `acrsolddemo.azurecr.io/sold/web@${DIGEST}`;
const ENV_ID = 'demo-eph-my-branch-1a2b';
const RG = `rg-sold-${ENV_ID}`;

const upOptions = {
  customer: 'demo',
  env: 'pr-42',
  image: IMAGE,
  releaseVersion: '0.1.0+demo.7',
  owner: 'chris',
};

function ephemeralInputs(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    env_id: ENV_ID,
    environment: 'eph-my-branch-1a2b',
    owner: 'chris',
    expires_at: '2026-10-01T12:00:00Z',
    release_version: '0.1.0+demo.7',
    image: IMAGE,
    worker_image: null,
    migrate_image: null,
    ...overrides,
  });
}

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) cleanup(dir);
});

function ctxWithRunner(setup?: (runner: FakeRunner) => void, overrides = {}): TestContext {
  const ctx = makeContext(overrides);
  setup?.(ctx.runner);
  return ctx;
}

describe('env:up', () => {
  it('creates an ephemeral environment: init with a per-env state key, apply with stamped expiry, migrate', async () => {
    const ctx = ctxWithRunner((r) => {
      r.on('output -raw url', { stdout: 'https://demo-eph.preview.example' });
      r.on('job start', { stdout: '{"name":"migrate-abc123"}' });
      r.on('execution show', { stdout: 'Succeeded\n' });
    });
    const plan = await envUp(ctx, upOptions);

    expect(plan.profile).toBe('ephemeral');
    expect(plan.envId).toMatch(/^demo-eph-pr-42-[0-9a-f]{4}$/);
    expect(plan.expiresAt).toBe('2026-10-02T12:00:00Z'); // default 48h from the fixed clock

    const [init, apply, url, job, exec] = ctx.runner.calls;
    expect(init?.line).toContain('/ops/terraform/environments/demo/ephemeral init');
    expect(init?.line).toContain(`-backend-config=key=ephemeral/${plan.envId}.tfstate`);
    expect(apply?.line).toContain(' apply -input=false -auto-approve');
    expect(apply?.line).toContain('-var-file=/repo/ops/terraform/profiles/ephemeral.tfvars');
    expect(apply?.line).toContain(`-var=env_id=${plan.envId}`);
    expect(apply?.line).toContain('-var=expires_at=2026-10-02T12:00:00Z');
    expect(apply?.line).toContain('-var=owner=chris');
    expect(apply?.line).toContain('-var=release_version=0.1.0+demo.7');
    expect(url?.line).toContain('output -raw url');
    expect(job?.line).toContain(
      `az containerapp job start --name migrate --resource-group rg-sold-${plan.envId}`,
    );
    expect(exec?.line).toContain('--job-execution-name migrate-abc123');
    expect(ctx.out.lines.at(-1)).toContain('ready:');
  });

  it('names the environment from --branch, deterministically', async () => {
    const a = await envUp(
      ctxWithRunner((r) =>
        r.on('job start', { stdout: '{"name":"m"}' }).on('execution show', { stdout: 'Succeeded' }),
      ),
      {
        ...upOptions,
        branch: 'feature/Checkout-V2',
      },
    );
    const b = await envUp(
      ctxWithRunner((r) =>
        r.on('job start', { stdout: '{"name":"m"}' }).on('execution show', { stdout: 'Succeeded' }),
      ),
      {
        ...upOptions,
        env: 'anything',
        branch: 'feature/Checkout-V2',
      },
    );
    expect(a.envId).toBe(b.envId);
    expect(a.environment).toMatch(/^eph-feature-chec-/);
  });

  it('gives previews a hostname under the preview domain when Cloudflare is configured, and passes it on every re-apply', async () => {
    const env = {
      CLOUDFLARE_ACCOUNT_ID: 'acct',
      CLOUDFLARE_ZONE_ID: 'zone',
      SOLD_PREVIEW_DOMAIN: 'preview.demo.example',
    };
    const ctx = ctxWithRunner(
      (r) =>
        r.on('job start', { stdout: '{"name":"m"}' }).on('execution show', { stdout: 'Succeeded' }),
      { env },
    );
    const plan = await envUp(ctx, upOptions);
    const apply = ctx.runner.calls[1]?.args.find((a) => a.startsWith('-var=cloudflare=')) ?? '';
    expect(JSON.parse(apply.replace('-var=cloudflare=', ''))).toEqual({
      enabled: true,
      account_id: 'acct',
      zone_id: 'zone',
      hostname: `${plan.envId}.preview.demo.example`,
    });
    const without = ctxWithRunner((r) =>
      r.on('job start', { stdout: '{"name":"m"}' }).on('execution show', { stdout: 'Succeeded' }),
    );
    await envUp(without, upOptions);
    expect(without.runner.calls[1]?.line).not.toContain('-var=cloudflare');
  });

  it('honours --ttl and refuses anything over the 7 day maximum', async () => {
    const ok = await envUp(
      ctxWithRunner((r) =>
        r.on('job start', { stdout: '{"name":"m"}' }).on('execution show', { stdout: 'Succeeded' }),
      ),
      { ...upOptions, ttl: '24h' },
    );
    expect(ok.expiresAt).toBe('2026-10-01T12:00:00Z');
    const ctx = ctxWithRunner();
    await expect(envUp(ctx, { ...upOptions, ttl: '200h' })).rejects.toMatchObject({
      exitCode: ExitCode.refused,
    });
    await expect(envUp(ctx, { ...upOptions, ttl: 'soon' })).rejects.toMatchObject({
      exitCode: ExitCode.usage,
    });
    expect(ctx.runner.calls).toHaveLength(0);
  });

  it('refuses when the customer already has the maximum number of ephemeral environments', async () => {
    const ctx = ctxWithRunner();
    for (let i = 0; i < DEFAULT_MAX_CONCURRENT_EPHEMERAL; i += 1) {
      ctx.azure.environments.push(environmentSummary({ envId: `demo-eph-b${i}-1a2b` }));
    }
    // other customers' and non-ephemeral environments do not count
    ctx.azure.environments.push(
      environmentSummary({ envId: 'other-eph-x-1a2b', customer: 'other' }),
    );
    ctx.azure.environments.push(
      environmentSummary({ envId: 'demo-dev', profile: 'dev', expiresAt: 'never' }),
    );
    const error = await envUp(ctx, upOptions).catch((e: unknown) => e as CliError);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(ExitCode.refused);
    expect((error as CliError).message).toMatch(/already has 5 ephemeral environments \(max 5\)/);
    expect((error as CliError).message).toContain('demo-eph-b0-1a2b');
    expect(ctx.runner.calls).toHaveLength(0);
  });

  it('allows one below the cap, honours --max-concurrent, and does not count the environment being updated', async () => {
    const setup = (r: FakeRunner) =>
      r.on('job start', { stdout: '{"name":"m"}' }).on('execution show', { stdout: 'Succeeded' });
    const four = ctxWithRunner(setup);
    for (let i = 0; i < 4; i += 1)
      four.azure.environments.push(environmentSummary({ envId: `demo-eph-b${i}-1a2b` }));
    await expect(envUp(four, upOptions)).resolves.toBeDefined();

    const capped = ctxWithRunner();
    capped.azure.environments.push(environmentSummary({ envId: 'demo-eph-b0-1a2b' }));
    await expect(envUp(capped, { ...upOptions, maxConcurrent: 1 })).rejects.toMatchObject({
      exitCode: ExitCode.refused,
    });

    const update = ctxWithRunner(setup);
    const first = await envUp(ctxWithRunner(setup), upOptions);
    update.azure.environments.push(environmentSummary({ envId: first.envId }));
    await expect(envUp(update, { ...upOptions, maxConcurrent: 1 })).resolves.toBeDefined();
  });

  it('never touches production', async () => {
    const ctx = ctxWithRunner();
    await expect(
      envUp(ctx, { customer: 'demo', env: 'prod', profile: 'prod' }),
    ).rejects.toMatchObject({
      exitCode: ExitCode.refused,
    });
    expect(ctx.runner.calls).toHaveLength(0);
  });

  it('validates inputs before running anything', async () => {
    const ctx = ctxWithRunner();
    const usage = { exitCode: ExitCode.usage };
    await expect(envUp(ctx, { ...upOptions, customer: 'Bad-Customer' })).rejects.toMatchObject(
      usage,
    );
    await expect(envUp(ctx, { ...upOptions, profile: 'qa' })).rejects.toMatchObject(usage);
    await expect(envUp(ctx, { ...upOptions, image: undefined })).rejects.toMatchObject(usage);
    await expect(
      envUp(ctx, { ...upOptions, image: 'acr.azurecr.io/sold/web:latest' }),
    ).rejects.toMatchObject(usage);
    await expect(
      envUp(ctx, { ...upOptions, releaseVersion: '0.1.0+other.7' }),
    ).rejects.toMatchObject(usage);
    await expect(envUp(ctx, { ...upOptions, releaseVersion: 'latest' })).rejects.toMatchObject(
      usage,
    );
    await expect(envUp(ctx, { ...upOptions, owner: 'bad owner!' })).rejects.toMatchObject(usage);
    await expect(
      envUp(ctx, { customer: 'demo', env: 'staging', profile: 'stage' }),
    ).rejects.toMatchObject(usage);
    await expect(
      envUp(ctx, { customer: 'demo', env: 'dev', profile: 'dev', ttl: '48h', owner: 'chris' }),
    ).rejects.toMatchObject(usage);
    expect(ctx.runner.calls).toHaveLength(0);
  });

  it('runs the migration job with the seed set for demo data', async () => {
    const ctx = ctxWithRunner((r) =>
      r.on('job start', { stdout: '{"name":"m1"}' }).on('execution show', { stdout: 'Succeeded' }),
    );
    await envUp(ctx, { ...upOptions, seed: 'demo' });
    expect(ctx.runner.find('job start')?.line).toContain('--env-vars SOLD_SEED=demo');
  });

  it('fails when the migration fails, and when it never finishes', async () => {
    const failed = ctxWithRunner((r) =>
      r.on('job start', { stdout: '{"name":"m1"}' }).on('execution show', { stdout: 'Failed' }),
    );
    await expect(envUp(failed, upOptions)).rejects.toThrow(/ended with status Failed/);

    let now = Date.parse('2026-09-30T12:00:00Z');
    const stuck = ctxWithRunner(
      (r) =>
        r.on('job start', { stdout: '{"name":"m1"}' }).on('execution show', { stdout: 'Running' }),
      {
        now: () => new Date(now),
        sleep: () => {
          now += 5 * 60_000;
          return Promise.resolve();
        },
      },
    );
    await expect(envUp(stuck, upOptions)).rejects.toThrow(/did not finish in 15 minutes/);
  });

  it('creates persistent dev and stage environments from profile (and tier) files, without env-specific vars', async () => {
    const setup = (r: FakeRunner) =>
      r.on('job start', { stdout: '{"name":"m"}' }).on('execution show', { stdout: 'Succeeded' });
    const dev = ctxWithRunner(setup);
    const devPlan = await envUp(dev, {
      customer: 'demo',
      env: 'dev',
      profile: 'dev',
      owner: 'chris',
    });
    expect(devPlan).toMatchObject({ envId: 'demo-dev', expiresAt: 'never', profile: 'dev' });
    const devApply = dev.runner.calls[1]?.line ?? '';
    expect(devApply).toContain('environments/demo/dev apply');
    expect(devApply).toContain('profiles/dev.tfvars');
    expect(devApply).not.toContain('tier-');
    expect(devApply).not.toContain('-var=');
    expect(dev.runner.calls[0]?.line).not.toContain('-backend-config'); // fixed state key in the root

    const stage = ctxWithRunner(setup);
    await envUp(stage, { customer: 'demo', env: 'stage', profile: 'stage', owner: 'chris' });
    const stageApply = stage.runner.calls[1]?.line ?? '';
    expect(stageApply).toContain('profiles/stage.tfvars');
    expect(stageApply).toContain('profiles/tier-standard.tfvars');
    expect(stageApply).toContain('-var=tier=standard');
  });

  it('--dry-run prints the exact actions and executes nothing', async () => {
    const ctx = ctxWithRunner(undefined, { dryRun: true });
    await envUp(ctx, { ...upOptions, seed: 'demo' });
    expect(ctx.runner.calls).toHaveLength(0);
    const text = ctx.out.lines.join('\n');
    expect(text).toContain(
      '[dry-run] run: terraform -chdir=/repo/ops/terraform/environments/demo/ephemeral init',
    );
    expect(text).toContain(
      '[dry-run] run: terraform -chdir=/repo/ops/terraform/environments/demo/ephemeral apply',
    );
    expect(text).toContain('-var=expires_at=2026-10-02T12:00:00Z');
    expect(text).toContain('[dry-run] run: az containerapp job start');
    expect(text).toContain('would be ready');
  });

  it('--dry-run downgrades a failing Azure guard query to a warning', async () => {
    const ctx = ctxWithRunner(undefined, { dryRun: true });
    ctx.azure.failWith = new Error('az: not logged in');
    await envUp(ctx, upOptions);
    expect(ctx.out.warnings.join('\n')).toContain('concurrency guard skipped in dry-run');
    const live = ctxWithRunner();
    live.azure.failWith = new Error('az: not logged in');
    await expect(envUp(live, upOptions)).rejects.toThrow(/cannot check the concurrency guard/);
  });
});

describe('env:down', () => {
  const inputsRunner = (r: FakeRunner) =>
    r.on('output -json inputs', { stdout: ephemeralInputs() });

  it('destroys with the inputs stored in state and verifies nothing is left', async () => {
    const ctx = ctxWithRunner(inputsRunner);
    ctx.azure.environments.push(environmentSummary({ envId: ENV_ID }));
    const code = await envDown(ctx, ENV_ID, { verify: true });
    expect(code).toBe(ExitCode.ok);
    const lines = ctx.runner.lines();
    expect(lines[0]).toContain(
      `init -input=false -no-color -reconfigure -backend-config=key=ephemeral/${ENV_ID}.tfstate`,
    );
    expect(lines[1]).toContain('output -json inputs');
    expect(lines[2]).toContain('destroy -input=false -auto-approve');
    expect(lines[2]).toContain('-var=expires_at=2026-10-01T12:00:00Z');
    expect(ctx.azure.queried).toEqual([`resources:${ENV_ID}`, `soft-deleted:${ENV_ID}`]);
    expect(ctx.cloudflare.queried).toEqual([ENV_ID]);
    expect(ctx.out.lines.at(-1)).toContain('verified');
  });

  it('--verify fails with exit code 3 and names every leftover', async () => {
    const ctx = ctxWithRunner(inputsRunner);
    ctx.azure.resources.push({
      envId: ENV_ID,
      source: 'azure',
      kind: 'microsoft.keyvault/vaults',
      id: '/kv',
      name: 'kv-left',
    });
    ctx.cloudflare.items.push({
      envId: ENV_ID,
      source: 'cloudflare',
      kind: 'dns-record',
      id: '9',
      name: 'x.example.com',
    });
    const code = await envDown(ctx, ENV_ID, { verify: true });
    expect(code).toBe(ExitCode.leftovers);
    expect(ctx.out.errors.join('\n')).toContain('kv-left');
    expect(ctx.out.errors.join('\n')).toContain('dns-record');
  });

  it('without --verify it says the result is unverified', async () => {
    const ctx = ctxWithRunner(inputsRunner);
    expect(await envDown(ctx, ENV_ID)).toBe(ExitCode.ok);
    expect(ctx.out.lines.at(-1)).toContain('not verified');
    expect(ctx.azure.queried).toHaveLength(0);
  });

  it('refuses production by name, by Azure tag, and by repository configuration', async () => {
    const byName = ctxWithRunner();
    await expect(envDown(byName, 'demo-prod')).rejects.toMatchObject({
      exitCode: ExitCode.refused,
    });
    expect(byName.runner.calls).toHaveLength(0);

    const byTag = ctxWithRunner();
    byTag.azure.environments.push(environmentSummary({ envId: ENV_ID, profile: 'prod' }));
    await expect(envDown(byTag, ENV_ID)).rejects.toThrow(/Azure tag sold:profile is 'prod'/);
    expect(byTag.runner.calls).toHaveLength(0);

    const dir = tempDir();
    cleanups.push(dir);
    writeTree(dir, {
      'ops/terraform/environments/demo/dev/main.tf':
        'module "environment" {\n  profile     = "prod"\n}\n',
    });
    const byConfig = ctxWithRunner(undefined, { cwd: dir });
    await expect(envDown(byConfig, 'demo-dev')).rejects.toThrow(/configures profile = "prod"/);
    expect(byConfig.runner.calls).toHaveLength(0);
  });

  it('has no override for production, not even with --delete-orphans', async () => {
    const ctx = ctxWithRunner();
    await expect(
      envDown(ctx, 'demo-prod', { deleteOrphans: true, verify: true }),
    ).rejects.toMatchObject({
      exitCode: ExitCode.refused,
    });
  });

  it('deletes an orphaned resource group only when asked and only if it is tagged ephemeral', async () => {
    const orphan = (profile: string) => {
      const ctx = ctxWithRunner((r) =>
        r.on('output -json inputs', { code: 1, stderr: 'no state' }),
      );
      ctx.azure.environments.push(environmentSummary({ envId: ENV_ID, profile }));
      ctx.azure.resources.push({ envId: ENV_ID, source: 'azure', kind: 'k', id: '/rg', name: RG });
      return ctx;
    };
    const ok = orphan('ephemeral');
    await envDown(ok, ENV_ID, { deleteOrphans: true });
    expect(ok.runner.find('az group delete')?.line).toContain(`--name ${RG} --yes`);

    const notRequested = orphan('ephemeral');
    await envDown(notRequested, ENV_ID);
    expect(notRequested.runner.find('az group delete')).toBeUndefined();
    expect(notRequested.out.warnings.join('\n')).toContain('no Terraform state');

    const wrongProfile = orphan('dev');
    await expect(envDown(wrongProfile, ENV_ID, { deleteOrphans: true })).rejects.toThrow(
      /not tagged sold:profile=ephemeral/,
    );
  });

  it('--dry-run lists the terraform commands and the verification queries without running anything', async () => {
    const ctx = ctxWithRunner(undefined, { dryRun: true });
    const code = await envDown(ctx, ENV_ID, { verify: true });
    expect(code).toBe(ExitCode.ok);
    expect(ctx.runner.calls).toHaveLength(0);
    const text = ctx.out.lines.join('\n');
    expect(text).toContain('destroy -input=false -auto-approve');
    expect(text).toContain('verification would run these queries');
    expect(text).toContain('(fake) azure resources tagged');
  });
});

describe('env:pause / env:resume', () => {
  const setup = (r: FakeRunner, state = 'Ready') =>
    r
      .on('output -json inputs', { stdout: ephemeralInputs() })
      .on('output -raw postgres_server_name', { stdout: 'psql-demo-x-abc123\n' })
      .on('flexible-server show', { stdout: `${state}\n` });

  it('scales to zero through Terraform, then stops PostgreSQL', async () => {
    const ctx = ctxWithRunner((r) => setup(r));
    await envPause(ctx, ENV_ID);
    const lines = ctx.runner.lines();
    expect(
      lines.some(
        (l) =>
          l.includes(' apply ') &&
          l.includes('-var=paused=true') &&
          l.includes(`-var=env_id=${ENV_ID}`),
      ),
    ).toBe(true);
    expect(lines.at(-1)).toBe(
      `az postgres flexible-server stop --resource-group ${RG} --name psql-demo-x-abc123`,
    );
  });

  it('keeps the edge on when re-applying an environment that has one', async () => {
    const ctx = ctxWithRunner((r) =>
      r
        .on('output -json inputs', {
          stdout: ephemeralInputs({
            cloudflare: { enabled: true, account_id: 'a', zone_id: 'z', hostname: 'h.example' },
          }),
        })
        .on('output -raw postgres_server_name', { stdout: 'psql-x' })
        .on('flexible-server show', { stdout: 'Ready' }),
    );
    await envPause(ctx, ENV_ID);
    const apply = ctx.runner.lines().find((l) => l.includes(' apply '));
    expect(apply).toContain('-var=cloudflare=');
    expect(apply).toContain('h.example');
  });

  it('is idempotent: an already stopped server is not stopped again', async () => {
    const ctx = ctxWithRunner((r) => setup(r, 'Stopped'));
    await envPause(ctx, ENV_ID);
    expect(ctx.runner.find('flexible-server stop')).toBeUndefined();
    expect(ctx.out.lines).toContain('PostgreSQL is already stopped');
  });

  it('refuses to pause production and environments without state', async () => {
    await expect(envPause(ctxWithRunner(), 'demo-prod')).rejects.toMatchObject({
      exitCode: ExitCode.refused,
    });
    const noState = ctxWithRunner((r) => r.on('output -json inputs', { code: 1 }));
    await expect(envPause(noState, ENV_ID)).rejects.toThrow(/no Terraform state/);
  });

  it('pauses persistent environments from repository files (no stored inputs)', async () => {
    const ctx = ctxWithRunner((r) =>
      r
        .on('output -raw postgres_server_name', { stdout: 'psql-demo-dev-abc123' })
        .on('flexible-server show', { stdout: 'Ready' }),
    );
    await envPause(ctx, 'demo-dev');
    const apply = ctx.runner.lines().find((l) => l.includes(' apply '));
    expect(apply).toContain('environments/demo/dev apply');
    expect(apply).toContain('-var=paused=true');
    expect(apply).not.toContain('-var=env_id');
  });

  it('resume starts PostgreSQL before restoring replicas', async () => {
    const ctx = ctxWithRunner((r) => setup(r, 'Stopped'));
    await envResume(ctx, ENV_ID);
    const lines = ctx.runner.lines();
    const start = lines.findIndex((l) => l.includes('flexible-server start'));
    const apply = lines.findIndex((l) => l.includes('-var=paused=false'));
    expect(start).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(start);
  });

  it('resume does not start a server that is already running', async () => {
    const ctx = ctxWithRunner((r) => setup(r, 'Ready'));
    await envResume(ctx, ENV_ID);
    expect(ctx.runner.find('flexible-server start')).toBeUndefined();
  });

  it('--dry-run prints everything and runs nothing', async () => {
    const ctx = ctxWithRunner(undefined, { dryRun: true });
    await envPause(ctx, ENV_ID);
    await envResume(ctx, ENV_ID);
    expect(ctx.runner.calls).toHaveLength(0);
    expect(ctx.out.lines.join('\n')).toContain('flexible-server stop');
    expect(ctx.out.lines.join('\n')).toContain('flexible-server start');
  });
});

describe('env:extend', () => {
  const setup = (r: FakeRunner) => r.on('output -json inputs', { stdout: ephemeralInputs() });

  it('adds the TTL to the current expiry and re-applies with the stored inputs', async () => {
    const ctx = ctxWithRunner(setup);
    ctx.azure.environments.push(
      environmentSummary({ envId: ENV_ID, expiresAt: '2026-10-01T12:00:00Z' }),
    );
    const next = await envExtend(ctx, ENV_ID, '24h');
    expect(next).toBe('2026-10-02T12:00:00Z');
    const apply = ctx.runner.lines().find((l) => l.includes(' apply '));
    expect(apply).toContain('-var=expires_at=2026-10-02T12:00:00Z');
    expect(apply).toContain('-var=owner=chris');
  });

  it('refuses to extend beyond 7 days from now, and non-ephemeral or unknown environments', async () => {
    const far = ctxWithRunner(setup);
    far.azure.environments.push(
      environmentSummary({ envId: ENV_ID, expiresAt: '2026-10-07T12:00:00Z' }),
    );
    await expect(envExtend(far, ENV_ID, '24h')).rejects.toMatchObject({
      exitCode: ExitCode.refused,
    });

    const persistent = ctxWithRunner();
    persistent.azure.environments.push(
      environmentSummary({ envId: 'demo-dev', profile: 'dev', expiresAt: 'never' }),
    );
    await expect(envExtend(persistent, 'demo-dev', '24h')).rejects.toMatchObject({
      exitCode: ExitCode.refused,
    });

    await expect(envExtend(ctxWithRunner(), ENV_ID, '24h')).rejects.toThrow(
      /no environment with env-id/,
    );
  });
});

describe('env:list', () => {
  const populated = () => {
    const ctx = makeContext();
    ctx.azure.environments.push(
      environmentSummary({ envId: 'demo-eph-old-1111', expiresAt: '2026-09-29T00:00:00Z' }),
      environmentSummary({ envId: 'demo-eph-soon-2222', expiresAt: '2026-10-01T06:00:00Z' }),
      environmentSummary({ envId: 'demo-eph-later-3333', expiresAt: '2026-10-05T00:00:00Z' }),
      environmentSummary({ envId: 'demo-dev', profile: 'dev', expiresAt: 'never' }),
      environmentSummary({
        envId: 'other-eph-x-4444',
        customer: 'other',
        expiresAt: '2026-09-29T00:00:00Z',
      }),
    );
    return ctx;
  };

  it('lists sorted environments in a table with relative expiry', async () => {
    const ctx = populated();
    await envList(ctx);
    expect(ctx.out.lines[0]).toMatch(/^ENV-ID\s+PROFILE\s+OWNER\s+EXPIRES\s+RELEASE$/);
    expect(ctx.out.lines.join('\n')).toContain('EXPIRED');
    expect(ctx.out.lines.join('\n')).toContain('never');
  });

  it('filters expired environments (what the nightly workflow destroys)', async () => {
    const ctx = populated();
    const envs = await envList(ctx, { expired: true, json: true });
    expect(envs.map((e) => e.envId)).toEqual(['demo-eph-old-1111', 'other-eph-x-4444']);
    expect(JSON.parse(ctx.out.lines[0] ?? '[]')).toHaveLength(2);
  });

  it('filters environments about to expire and by customer', async () => {
    const ctx = populated();
    const soon = await envList(ctx, { expiringWithinMs: 24 * 3_600_000, customer: 'demo' });
    expect(soon.map((e) => e.envId)).toEqual(['demo-eph-soon-2222']);
  });

  it('says so when there is nothing', async () => {
    const ctx = makeContext();
    await envList(ctx);
    expect(ctx.out.lines).toEqual(['no environments']);
  });
});

describe('env:cost', () => {
  const body = (rows: unknown[][]) =>
    JSON.stringify({ properties: { columns: [{ name: 'Cost' }, { name: 'Currency' }], rows } });

  it('parses the Cost Management response', () => {
    expect(parseCostQuery(body([[12.5, 'AUD']]))).toEqual({ cost: 12.5, currency: 'AUD' });
    expect(
      parseCostQuery(
        body([
          [1, 'AUD'],
          [2.25, 'AUD'],
        ]),
      ),
    ).toEqual({ cost: 3.25, currency: 'AUD' });
    expect(parseCostQuery(body([]))).toEqual({ cost: 0, currency: undefined });
    expect(parseCostQuery('not json')).toBeUndefined();
    expect(parseCostQuery(body([['x', 'AUD']]))).toBeUndefined();
  });

  it('queries each environment resource group and reports unavailable data honestly', async () => {
    const ctx = makeContext();
    ctx.azure.environments.push(
      environmentSummary({ envId: 'demo-eph-a-1111' }),
      environmentSummary({ envId: 'demo-eph-b-2222' }),
    );
    ctx.runner.on('demo-eph-a-1111/providers', { stdout: body([[4.2, 'AUD']]) });
    ctx.runner.on('demo-eph-b-2222/providers', { code: 1, stderr: 'AuthorizationFailed' });
    const rows = await envCost(ctx);
    expect(rows).toEqual([
      { envId: 'demo-eph-a-1111', monthToDate: 4.2, currency: 'AUD', budget: undefined },
      { envId: 'demo-eph-b-2222', monthToDate: undefined, currency: undefined, budget: undefined },
    ]);
    const report = ctx.out.lines.filter((l) => !l.startsWith('>'));
    expect(report[0]).toContain('4.20 AUD');
    expect(report[1]).toContain('unavailable');
    expect(ctx.runner.calls[0]?.line).toContain(
      '/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-sold-demo-eph-a-1111/providers/Microsoft.CostManagement/query',
    );
  });

  it('fails for an unknown environment', async () => {
    await expect(envCost(makeContext(), { envId: 'demo-eph-nope-0000' })).rejects.toThrow(
      /no environment/,
    );
  });
});

describe('env:plan', () => {
  const runIn = async (cwd: string, planCode: number, opts = {}, envId = 'demo-stage') => {
    const ctx = makeContext({ cwd });
    ctx.runner
      .on(' plan ', { code: planCode, stderr: planCode > 2 ? 'Error: backend unreachable' : '' })
      .on(' show ', { stdout: '{"resource_changes":[]}' });
    const code = await envPlan(ctx, envId, opts);
    return { ctx, code };
  };

  it('plans read-only with profile and tier files, mapping terraform exit codes (0 none, 2 changes)', async () => {
    const dir = tempDir();
    cleanups.push(dir);
    const none = await runIn(dir, 0);
    expect(none.code).toBe(ExitCode.ok);
    const plan = none.ctx.runner.find(' plan ')?.line ?? '';
    expect(plan).toContain('-detailed-exitcode -out=tfplan');
    expect(plan).toContain('profiles/stage.tfvars');
    expect(plan).toContain('profiles/tier-standard.tfvars');
    expect(plan).not.toContain('-lock=false');
    expect((await runIn(dir, 2)).code).toBe(ExitCode.changes);
  });

  it('is allowed for production because it cannot change anything', async () => {
    const dir = tempDir();
    cleanups.push(dir);
    const { code, ctx } = await runIn(dir, 0, { noLock: true }, 'demo-prod');
    expect(code).toBe(ExitCode.ok);
    expect(ctx.runner.find(' plan ')?.line).toContain('-lock=false');
    expect(ctx.runner.lines().some((l) => l.includes(' apply ') || l.includes(' destroy '))).toBe(
      false,
    );
  });

  it('writes the JSON plan for the tag check, surfaces failures, and rejects ephemeral environments', async () => {
    const dir = tempDir();
    cleanups.push(dir);
    const out = `${dir}/plan.json`;
    await runIn(dir, 2, { jsonOut: out });
    expect(await import('node:fs').then((fs) => fs.readFileSync(out, 'utf8'))).toBe(
      '{"resource_changes":[]}',
    );
    await expect(runIn(dir, 1)).rejects.toThrow(/terraform plan failed/);
    await expect(runIn(dir, 0, {}, ENV_ID)).rejects.toMatchObject({ exitCode: ExitCode.usage });
  });

  it('--dry-run prints the plan command only', async () => {
    const ctx = makeContext({ dryRun: true });
    expect(await envPlan(ctx, 'demo-dev')).toBe(ExitCode.ok);
    expect(ctx.runner.calls).toHaveLength(0);
    expect(ctx.out.lines.join('\n')).toContain('[dry-run] run: terraform');
  });
});
