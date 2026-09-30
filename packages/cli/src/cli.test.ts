import { afterEach, describe, expect, it } from 'vitest';
import { run } from './cli';
import { ExitCode } from './lib/errors';
import { cleanup, makeContext, tempDir, writeTree, type TestContext } from './testing';
import { serializeRelease } from './release/schemas';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanup(d);
});

function harness(overrides: Partial<TestContext> = {}) {
  const contexts: TestContext[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exec = async (...argv: string[]): Promise<number> =>
    run(argv, {
      createContext: (flags) => {
        const ctx = makeContext({ ...overrides, dryRun: flags.dryRun });
        contexts.push(ctx);
        return ctx;
      },
      writeOut: (t) => stdout.push(t),
      writeErr: (t) => stderr.push(t),
    });
  return { exec, contexts, stdout, stderr };
}

const IMAGE = `acrsolddemo.azurecr.io/sold/web@sha256:${'a'.repeat(64)}`;

describe('sold CLI surface', () => {
  it('registers every command of the Phase 0 spec', async () => {
    const h = harness();
    expect(await h.exec('--help')).toBe(ExitCode.ok);
    const help = h.stdout.join('');
    for (const command of [
      'env:up',
      'env:pause',
      'env:resume',
      'env:extend',
      'env:list',
      'env:cost',
      'env:down',
      'customer:new',
      'upgrade:check',
      'upgrade:plan',
      'upgrade:apply',
      'drift:check',
      'promote',
      'release:stamp',
      'release:version',
      'data:snapshot',
      'content:export',
      'content:import',
    ]) {
      expect(help, command).toContain(command);
    }
    expect(help).toContain('--dry-run');
  });

  it('every command supports --dry-run (the flag is global)', async () => {
    const h = harness();
    await h.exec(
      'env:up',
      'demo',
      'x',
      '--image',
      IMAGE,
      '--release-version',
      '0.1.0+demo.1',
      '--owner',
      'me',
      '--dry-run',
    );
    expect(h.contexts[0]?.dryRun).toBe(true);
    expect(h.contexts[0]?.runner.calls).toHaveLength(0);
    await h.exec(
      'env:up',
      'demo',
      'x',
      '--image',
      IMAGE,
      '--release-version',
      '0.1.0+demo.1',
      '--owner',
      'me',
    );
    expect(h.contexts[1]?.dryRun).toBe(false);
  });

  it('maps errors to stable exit codes', async () => {
    expect(await harness().exec('nonsense')).toBe(ExitCode.usage);
    expect(await harness().exec('env:up')).toBe(ExitCode.usage); // missing arguments
    const usage = harness();
    expect(
      await usage.exec(
        'env:up',
        'demo',
        'x',
        '--ttl',
        'soon',
        '--image',
        IMAGE,
        '--release-version',
        '0.1.0+demo.1',
        '--owner',
        'me',
      ),
    ).toBe(ExitCode.usage);
    const refused = harness();
    expect(await refused.exec('env:up', 'demo', 'prod', '--profile', 'prod')).toBe(
      ExitCode.refused,
    );
    expect(refused.contexts[0]?.out.errors.join('\n')).toContain('never touches production');
    const prod = harness();
    expect(await prod.exec('env:down', 'demo-prod')).toBe(ExitCode.refused);
  });

  it('env:down --verify returns the leftovers exit code', async () => {
    const h = harness();
    h.contexts.length = 0;
    const code = await run(['env:down', 'demo-eph-a-1a2b', '--verify'], {
      createContext: (flags) => {
        const ctx = makeContext({ dryRun: flags.dryRun });
        ctx.runner.on('output -json inputs', {
          stdout: JSON.stringify({
            env_id: 'demo-eph-a-1a2b',
            environment: 'eph-a-1a2b',
            owner: 'me',
            expires_at: '2026-10-01T00:00:00Z',
            release_version: '0.1.0+demo.1',
            image: IMAGE,
          }),
        });
        ctx.azure.resources.push({
          envId: 'demo-eph-a-1a2b',
          source: 'azure',
          kind: 'k',
          id: '/x',
          name: 'left-behind',
        });
        h.contexts.push(ctx);
        return ctx;
      },
    });
    expect(code).toBe(ExitCode.leftovers);
    expect(h.contexts[0]?.out.errors.join('\n')).toContain('left-behind');
  });

  it('data and content commands are stubs: a clear message and a non-zero exit', async () => {
    for (const cmd of [['data:snapshot', '--anonymise'], ['content:export'], ['content:import']]) {
      const h = harness();
      expect(await h.exec(...cmd)).toBe(ExitCode.notImplemented);
      expect(h.contexts[0]?.out.errors[0]).toContain('not implemented in Phase 0');
    }
  });

  it('promote copies release.json through the CLI', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeTree(dir, {
      'environments/dev/release.json': serializeRelease({
        baseVersion: '1.0.0',
        instanceBuild: 3,
        imageDigest: `sha256:${'c'.repeat(64)}`,
        extensionVersions: {},
        terraformModuleVersion: '1.0.0',
      }),
    });
    const h = harness({ cwd: dir });
    expect(await h.exec('promote', 'dev', 'stage')).toBe(ExitCode.ok);
    expect(h.contexts[0]?.out.lines.join('\n')).toContain('wrote environments/stage/release.json');
    expect(await h.exec('promote', 'dev', 'prod')).toBe(ExitCode.refused);
  });

  it('env:id prints the env-id for a branch, deterministically, and for persistent environments', async () => {
    const h = harness();
    expect(await h.exec('env:id', '--branch', 'feature/Checkout-V2')).toBe(ExitCode.ok);
    expect(await h.exec('env:id', '--branch', 'feature/Checkout-V2')).toBe(ExitCode.ok);
    const [first, second] = [h.contexts[0]?.out.lines[0], h.contexts[1]?.out.lines[0]];
    expect(first).toMatch(/^demo-eph-feature-chec-[0-9a-f]{4}$/);
    expect(first).toBe(second);
    expect(await h.exec('env:id', '--env', 'stage')).toBe(ExitCode.ok);
    expect(h.contexts[2]?.out.lines).toEqual(['demo-stage']);
    expect(await h.exec('env:id', '--env', 'qa')).toBe(ExitCode.usage);
    expect(await h.exec('env:id')).toBe(ExitCode.usage);
  });

  it('release:deploy prod and release:freeze-check are guarded', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const h = harness({ cwd: dir });
    expect(await h.exec('release:deploy', 'prod')).toBe(ExitCode.refused);
    expect(h.contexts[0]?.out.errors.join('\n')).toContain('Nobody changes prod by hand');
    const frozen = harness({ cwd: dir, env: { SOLD_DEPLOY_FREEZE: 'true' } });
    expect(await frozen.exec('release:freeze-check')).toBe(ExitCode.refused);
    expect(
      await frozen.exec('release:freeze-check', '--override', 'hotfix for payment outage'),
    ).toBe(ExitCode.ok);
  });

  it('release:version prints <base-version>+<customer>.<instance-build>', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeTree(dir, {
      'environments/stage/release.json': serializeRelease({
        baseVersion: '1.4.0',
        instanceBuild: 27,
        imageDigest: `sha256:${'d'.repeat(64)}`,
        extensionVersions: {},
        terraformModuleVersion: '1.4.0',
      }),
    });
    const h = harness({ cwd: dir });
    expect(await h.exec('release:version', 'stage')).toBe(ExitCode.ok);
    expect(h.contexts[0]?.out.lines).toEqual(['1.4.0+demo.27']);
    expect(await h.exec('release:version', 'prod')).toBe(ExitCode.failure);
  });

  it('env:list --expired --json is what the nightly workflow consumes', async () => {
    const h = harness();
    h.contexts.length = 0;
    const code = await run(['env:list', '--expired', '--json'], {
      createContext: (flags) => {
        const ctx = makeContext({ dryRun: flags.dryRun });
        ctx.azure.environments.push({
          envId: 'demo-eph-old-1111',
          customer: 'demo',
          environment: 'eph-old-1111',
          profile: 'ephemeral',
          owner: 'me',
          expiresAt: '2026-09-01T00:00:00Z',
          release: '0.1.0+demo.1',
          resourceGroup: 'rg-sold-demo-eph-old-1111',
          subscriptionId: 's',
        });
        h.contexts.push(ctx);
        return ctx;
      },
    });
    expect(code).toBe(ExitCode.ok);
    expect(JSON.parse(h.contexts[0]?.out.lines[0] ?? '[]')[0].envId).toBe('demo-eph-old-1111');
  });
});
