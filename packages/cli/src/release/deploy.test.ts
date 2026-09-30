import { afterEach, describe, expect, it } from 'vitest';
import { ExitCode } from '../lib/errors';
import { cleanup, FakeRunner, makeContext, tempDir, writeTree, type TestContext } from '../testing';
import {
  AzureMonitorAlertsProbe,
  MIGRATE_JOB_TARGET,
  releaseDeploy,
  type SloProbe,
} from './deploy';
import { checkDeployFreeze, evaluateFreeze, freezeFileSchema } from './freeze';
import { PLACEHOLDER_DIGEST, serializeRelease, type ReleaseJson } from './schemas';

const d = (c: string): string => `sha256:${c.repeat(64)}`;
const release = (overrides: Partial<ReleaseJson> = {}): ReleaseJson => ({
  baseVersion: '1.4.0',
  instanceBuild: 27,
  imageDigest: d('a'),
  extensionVersions: {},
  terraformModuleVersion: '1.4.0',
  ...overrides,
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanup(dir);
});

function repo(files: Record<string, string> = {}): string {
  const dir = tempDir();
  dirs.push(dir);
  writeTree(dir, {
    'environments/dev/release.json': serializeRelease(release()),
    'environments/stage/release.json': serializeRelease(release()),
    'environments/prod/release.json': serializeRelease(release()),
    'ops/terraform/profiles/dev.tfvars': 'profile_settings = {\n  revision_mode = "Single"\n}\n',
    'ops/terraform/profiles/stage.tfvars':
      'profile_settings = {\n  revision_mode = "Multiple"\n}\n',
    'ops/terraform/profiles/prod.tfvars': 'profile_settings = {\n  revision_mode = "Multiple"\n}\n',
    ...files,
  });
  return dir;
}

const healthy: SloProbe = { check: () => Promise.resolve({ healthy: true, detail: 'ok' }) };

function ctxFor(
  dir: string,
  setup?: (r: FakeRunner) => void,
  overrides: Partial<TestContext> = {},
): TestContext {
  const ctx = makeContext({ cwd: dir, ...overrides });
  ctx.runner
    .on('revision list', {
      stdout: JSON.stringify([
        { name: 'web--b26', properties: { active: true, trafficWeight: 100 } },
        { name: 'web--b25', properties: { active: true, trafficWeight: 0 } },
      ]),
    })
    .on('job start', { stdout: '{"name":"migrate-1"}' })
    .on('execution show', { stdout: 'Succeeded' })
    .on('revision show', { stdout: 'Healthy' })
    .on('account show', { stdout: 'sub-1\n' });
  setup?.(ctx.runner);
  return ctx;
}

const lines = (ctx: TestContext): string[] =>
  ctx.runner.lines().map((l) => l.replace(/^terraform -chdir=\S+ /, 'tf '));

describe('release:deploy', () => {
  it('stage: creates the revision at 0%, migrates, then shifts 10/50/100 with SLO checks, and retires the previous revision', async () => {
    const ctx = ctxFor(repo());
    const result = await releaseDeploy(ctx, { environment: 'stage', slo: healthy });
    expect(result).toMatchObject({
      envId: 'demo-stage',
      versionId: '1.4.0+demo.27',
      revisionSuffix: 'b27',
      strategy: 'canary',
      rolledBack: false,
    });

    const l = lines(ctx);
    const idx = (fragment: string): number => l.findIndex((x) => x.includes(fragment));
    expect(l[0]).toContain('init -input=false');
    expect(l[idx('canary_percent=0')]).toContain('-var=previous_revision_suffix=b26');
    expect(idx('job start')).toBeGreaterThan(idx('canary_percent=0'));
    expect(idx('canary_percent=10')).toBeGreaterThan(idx('job start'));
    expect(idx('canary_percent=50')).toBeGreaterThan(idx('canary_percent=10'));
    expect(idx('canary_percent=100')).toBeGreaterThan(idx('canary_percent=50'));
    expect(l.at(-1)).toBe(
      'az containerapp revision deactivate --name web --resource-group rg-sold-demo-stage --revision web--b26',
    );
    // stage takes capacity from profile + tier
    expect(l[idx('canary_percent=0')]).toContain('profiles/stage.tfvars');
    expect(l[idx('canary_percent=0')]).toContain('profiles/tier-standard.tfvars');
  });

  it('soaks between steps', async () => {
    const slept: number[] = [];
    const ctx = ctxFor(repo(), undefined, { sleep: (ms) => (slept.push(ms), Promise.resolve()) });
    await releaseDeploy(ctx, { environment: 'stage', slo: healthy, soakMs: 300_000 });
    expect(slept.filter((ms) => ms === 300_000)).toHaveLength(2); // after 10% and 50%, not after 100%
  });

  it('rolls back to the previous revision and fails when the SLO burns during the canary', async () => {
    const ctx = ctxFor(repo());
    let calls = 0;
    const burning: SloProbe = {
      check: () =>
        Promise.resolve(
          ++calls === 2
            ? { healthy: false, detail: 'alerts fired: web-5xx' }
            : { healthy: true, detail: 'ok' },
        ),
    };
    await expect(releaseDeploy(ctx, { environment: 'stage', slo: burning })).rejects.toThrow(
      /rolled back at 50%[\s\S]*Traffic is back on b26/,
    );
    const l = lines(ctx);
    const apply = l.filter((x) => x.includes(' apply '));
    expect(apply.map((x) => /canary_percent=(\d+)/.exec(x)?.[1])).toEqual(['0', '10', '50', '0']);
    expect(l.some((x) => x.includes('revision deactivate'))).toBe(false); // previous revision stays
    expect(ctx.out.errors.join('\n')).toContain('SLO burn detected at 50%');
  });

  it('does not shift any traffic when the migration fails or the revision is unhealthy', async () => {
    const ctx = makeContext({ cwd: repo() });
    ctx.runner
      .on('execution show', { stdout: 'Failed' })
      .on('revision list', {
        stdout: JSON.stringify([
          { name: 'web--b26', properties: { active: true, trafficWeight: 100 } },
        ]),
      })
      .on('job start', { stdout: '{"name":"m"}' });
    await expect(releaseDeploy(ctx, { environment: 'stage', slo: healthy })).rejects.toThrow(
      /no traffic was shifted/,
    );
    expect(ctx.runner.lines().filter((x) => x.includes('canary_percent=10'))).toHaveLength(0);

    const unhealthy = makeContext({ cwd: repo() });
    unhealthy.runner
      .on('revision show', { stdout: 'Unhealthy' })
      .on('revision list', {
        stdout: JSON.stringify([
          { name: 'web--b26', properties: { active: true, trafficWeight: 100 } },
        ]),
      })
      .on('job start', { stdout: '{"name":"m"}' })
      .on('execution show', { stdout: 'Succeeded' });
    await expect(releaseDeploy(unhealthy, { environment: 'stage', slo: healthy })).rejects.toThrow(
      /unhealthy/,
    );
    expect(unhealthy.runner.lines().filter((x) => x.includes('canary_percent=10'))).toHaveLength(0);
  });

  it('dev (single revision mode) migrates BEFORE rolling out, using a targeted apply for the migrate job', async () => {
    const ctx = ctxFor(repo());
    const result = await releaseDeploy(ctx, { environment: 'dev' });
    expect(result.strategy).toBe('migrate-then-apply');
    const l = lines(ctx);
    const targeted = l.findIndex((x) => x.includes(`-target=${MIGRATE_JOB_TARGET}`));
    const job = l.findIndex((x) => x.includes('job start'));
    const full = l.findIndex((x, i) => i > job && x.includes(' apply '));
    expect(targeted).toBeGreaterThan(-1);
    expect(job).toBeGreaterThan(targeted);
    expect(full).toBeGreaterThan(job);
    expect(l.some((x) => x.includes('canary_percent'))).toBe(false);
  });

  it('the first ever deploy of a multi-revision environment (no previous revision) also migrates first', async () => {
    const ctx = makeContext({ cwd: repo() });
    ctx.runner
      .on('revision list', { stdout: '[]' })
      .on('job start', { stdout: '{"name":"m"}' })
      .on('execution show', { stdout: 'Succeeded' })
      .on('revision show', { stdout: 'Healthy' });
    const result = await releaseDeploy(ctx, { environment: 'stage', slo: healthy });
    expect(result.strategy).toBe('migrate-then-apply');
  });

  it('validates canary steps and refuses placeholder or missing releases', async () => {
    const bad = makeContext({ cwd: repo() });
    for (const steps of [
      [10, 50],
      [50, 10, 100],
      [0, 100],
      [100, 100],
    ]) {
      await expect(
        releaseDeploy(bad, { environment: 'stage', canarySteps: steps }),
      ).rejects.toMatchObject({ exitCode: ExitCode.usage });
    }
    const placeholder = makeContext({
      cwd: repo({
        'environments/dev/release.json': serializeRelease(
          release({ imageDigest: PLACEHOLDER_DIGEST }),
        ),
      }),
    });
    await expect(releaseDeploy(placeholder, { environment: 'dev' })).rejects.toMatchObject({
      exitCode: ExitCode.refused,
    });
    await expect(
      releaseDeploy(makeContext({ cwd: tempDir() }), { environment: 'dev' }),
    ).rejects.toThrow(/does not exist/);
    await expect(releaseDeploy(bad, { environment: 'qa' })).rejects.toMatchObject({
      exitCode: ExitCode.usage,
    });
  });

  it('production deploys only from the approved release job, and honour the deploy freeze', async () => {
    const dir = repo();
    const local = makeContext({ cwd: dir });
    await expect(releaseDeploy(local, { environment: 'prod', slo: healthy })).rejects.toMatchObject(
      { exitCode: ExitCode.refused },
    );
    expect(local.runner.calls).toHaveLength(0);

    const asWorkflow = { GITHUB_ACTIONS: 'true', SOLD_DEPLOY_APPROVED: 'prod' };
    const frozen = ctxFor(dir, undefined, { env: { ...asWorkflow, SOLD_DEPLOY_FREEZE: 'true' } });
    await expect(releaseDeploy(frozen, { environment: 'prod', slo: healthy })).rejects.toThrow(
      /frozen/,
    );
    expect(frozen.runner.calls).toHaveLength(0);

    const overridden = ctxFor(dir, undefined, {
      env: { ...asWorkflow, SOLD_DEPLOY_FREEZE: 'true' },
    });
    await releaseDeploy(overridden, {
      environment: 'prod',
      slo: healthy,
      freezeOverride: 'critical security fix CVE-2026-0001',
    });
    expect(overridden.out.warnings.join('\n')).toContain('DEPLOY FREEZE OVERRIDDEN');

    const ok = ctxFor(dir, undefined, { env: asWorkflow });
    const result = await releaseDeploy(ok, { environment: 'prod', slo: healthy });
    expect(result.envId).toBe('demo-prod');
    expect(ok.runner.lines().some((x) => x.includes('profiles/prod.tfvars'))).toBe(true);
  });

  it('--dry-run prints the whole sequence and changes nothing', async () => {
    const ctx = ctxFor(repo(), undefined, { dryRun: true });
    await releaseDeploy(ctx, { environment: 'stage', previousBuild: 26, slo: healthy });
    expect(ctx.runner.calls).toHaveLength(0);
    const text = ctx.out.lines.join('\n');
    expect(text).toContain('canary_percent=0');
    expect(text).toContain('canary_percent=50');
    expect(text).toContain('az containerapp job start');
    expect(text).toContain('revision deactivate');
  });

  it('a redeploy of the already-serving revision does not use a canary', async () => {
    const ctx = makeContext({ cwd: repo() });
    ctx.runner
      .on('revision list', {
        stdout: JSON.stringify([
          { name: 'web--b27', properties: { active: true, trafficWeight: 100 } },
        ]),
      })
      .on('job start', { stdout: '{"name":"m"}' })
      .on('execution show', { stdout: 'Succeeded' })
      .on('revision show', { stdout: 'Healthy' });
    const result = await releaseDeploy(ctx, { environment: 'stage', slo: healthy });
    expect(result.strategy).toBe('migrate-then-apply');
  });
});

describe('AzureMonitorAlertsProbe (placeholder SLO signal)', () => {
  const since = new Date('2026-09-30T12:00:00Z');
  const probe = (stdout: string, code = 0) => {
    const runner = new FakeRunner().on('az rest', { stdout, code, stderr: code ? 'denied' : '' });
    return new AzureMonitorAlertsProbe({ runner }).check({
      subscriptionId: 's',
      resourceGroup: 'rg',
      since,
    });
  };
  const alert = (name: string, severity: string, startDateTime: string) => ({
    name,
    properties: { essentials: { severity, startDateTime } },
  });

  it('is healthy without alerts and ignores old or low-severity alerts', async () => {
    expect((await probe(JSON.stringify({ value: [] }))).healthy).toBe(true);
    const value = [
      alert('old', 'Sev1', '2026-09-30T11:00:00Z'),
      alert('minor', 'Sev4', '2026-09-30T12:30:00Z'),
    ];
    expect((await probe(JSON.stringify({ value }))).healthy).toBe(true);
  });

  it('reports fired Sev0-2 alerts since the deploy started', async () => {
    const verdict = await probe(
      JSON.stringify({ value: [alert('web-5xx', 'Sev2', '2026-09-30T12:05:00Z')] }),
    );
    expect(verdict).toEqual({ healthy: false, detail: 'alerts fired: web-5xx' });
  });

  it('fails closed on query errors and unreadable output', async () => {
    expect((await probe('', 1)).healthy).toBe(false);
    expect((await probe('not json')).healthy).toBe(false);
  });
});

describe('deploy freeze', () => {
  const at = (iso: string) => ({ now: () => new Date(iso) });
  const freezeFile = (windows: unknown[]) => ({
    'environments/prod/freeze.json': JSON.stringify({ windows }),
  });

  it('is not frozen by default', async () => {
    const ctx = makeContext({ cwd: repo() });
    expect(await evaluateFreeze(ctx)).toEqual({ frozen: false, reasons: [] });
    await expect(checkDeployFreeze(ctx)).resolves.toMatchObject({ frozen: false });
  });

  it('freezes inside a window (start inclusive, end exclusive)', async () => {
    const files = freezeFile([
      { from: '2026-11-25T00:00:00Z', to: '2026-12-02T00:00:00Z', reason: 'Black Friday' },
    ]);
    const dir = repo(files);
    expect(
      (await evaluateFreeze(makeContext({ cwd: dir, ...at('2026-11-25T00:00:00Z') }))).frozen,
    ).toBe(true);
    expect(
      (await evaluateFreeze(makeContext({ cwd: dir, ...at('2026-12-01T23:59:59Z') }))).reasons[0],
    ).toContain('Black Friday');
    expect(
      (await evaluateFreeze(makeContext({ cwd: dir, ...at('2026-12-02T00:00:00Z') }))).frozen,
    ).toBe(false);
    expect(
      (await evaluateFreeze(makeContext({ cwd: dir, ...at('2026-11-24T23:59:59Z') }))).frozen,
    ).toBe(false);
  });

  it('honours the repository-wide switch and refuses weak overrides', async () => {
    const ctx = makeContext({ cwd: repo(), env: { SOLD_DEPLOY_FREEZE: 'true' } });
    await expect(checkDeployFreeze(ctx)).rejects.toMatchObject({ exitCode: ExitCode.refused });
    await expect(checkDeployFreeze(ctx, 'because')).rejects.toMatchObject({
      exitCode: ExitCode.refused,
    });
    await expect(checkDeployFreeze(ctx, 'hotfix for payment outage')).resolves.toMatchObject({
      frozen: true,
    });
  });

  it('a malformed freeze file fails the check instead of disabling the freeze', async () => {
    const ctx = makeContext({
      cwd: repo({
        'environments/prod/freeze.json': '{"windows":[{"from":"x","to":"y","reason":""}]}',
      }),
    });
    await expect(evaluateFreeze(ctx)).rejects.toThrow(/freeze.json is invalid/);
    expect(
      freezeFileSchema.safeParse({
        windows: [{ from: '2026-01-02T00:00:00Z', to: '2026-01-01T00:00:00Z', reason: 'x' }],
      }).success,
    ).toBe(false);
  });
});
