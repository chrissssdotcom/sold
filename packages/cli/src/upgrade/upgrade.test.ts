import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExitCode } from '../lib/errors';
import {
  cleanup,
  commitAll,
  git,
  GitPassthroughRunner,
  makeContext,
  writeTree,
  type TestContext,
} from '../testing';
import { upgradeApply, upgradeGates } from './apply';
import { upgradeCheck, versionsAvailable } from './check';
import { driftCheck } from './drift';
import { createFixture, type Fixture } from './fixture';
import { Git } from './git';
import { upgradeBranchName, upgradePlan } from './plan';

let fx: Fixture;
let ctx: TestContext;
let repo: Git;

const read = (path: string): string => readFileSync(join(fx.instance, path), 'utf8');
const exists = (path: string): boolean => existsSync(join(fx.instance, path));

beforeEach(() => {
  fx = createFixture();
  const runner = new GitPassthroughRunner();
  // Codemods are `pnpm exec tsx <file>`: simulate their effect on the working tree.
  runner.on(
    (command, args) =>
      command === 'pnpm' && args[0] === 'exec' && args[2] === 'upgrades/1.1.0/001-rename.ts',
    (_c, _a, options) => {
      writeFileSync(
        join(fx.instance, 'apps/web/codemod-output.ts'),
        `// from ${options?.env?.['SOLD_UPGRADE_FROM']} to ${options?.env?.['SOLD_UPGRADE_TO']}\n`,
      );
      return { code: 0, stdout: '', stderr: '' };
    },
  );
  ctx = makeContext({ cwd: fx.instance, runner });
  repo = new Git(runner, fx.instance);
});

afterEach(() => cleanup(fx.root));

describe('upgrade:check', () => {
  it('lists newer releases, tagged changes since the current version and extension compatibility', async () => {
    const report = await upgradeCheck(ctx, repo);
    expect(report).toMatchObject({
      current: '1.0.0',
      target: '1.1.0',
      available: ['1.0.1', '1.1.0'],
      upToDate: false,
    });
    expect(report.changes.breaking.map((e) => e.text)).toEqual(['Removed the legacy cart API']);
    expect(report.changes.migration).toHaveLength(1);
    expect(report.changes.infra).toHaveLength(1);
    expect(report.changes.security.map((e) => e.version)).toEqual(['1.0.1', '1.1.0']);
    expect(report.extensions).toEqual([
      expect.objectContaining({
        name: '@demo/loyalty',
        status: 'compatible',
        range: '>=1.0.0 <2.0.0',
      }),
    ]);
    expect(ctx.out.lines.join('\n')).toContain('BREAKING (1)');
    expect(ctx.out.lines.join('\n')).toContain('next: sold upgrade:plan 1.1.0');
  });

  it('fetches tags from the upstream remote first', async () => {
    await upgradeCheck(ctx, repo);
    expect(ctx.runner.lines()[0]).toBe('git fetch upstream --tags --quiet');
  });

  it('reports a specific target, patch-only releases, and being up to date', async () => {
    expect((await upgradeCheck(ctx, repo, { to: '1.0.1' })).target).toBe('1.0.1');
    expect((await upgradeCheck(ctx, repo, { patchOnly: true })).available).toEqual(['1.0.1']);
    await expect(upgradeCheck(ctx, repo, { to: '9.9.9' })).rejects.toMatchObject({
      exitCode: ExitCode.usage,
    });

    writeFileSync(join(fx.instance, '.sold/base-version'), '1.1.0\n');
    const latest = await upgradeCheck(makeContext({ cwd: fx.instance, runner: ctx.runner }), repo);
    expect(latest.upToDate).toBe(true);
  });

  it('flags extensions incompatible with the target and fails in --strict mode', async () => {
    writeTree(fx.instance, {
      'extensions/loyalty/package.json': JSON.stringify({
        name: '@demo/loyalty',
        sold: { requires: { base: '>=1.0.0 <1.1.0' } },
      }),
    });
    const report = await upgradeCheck(ctx, repo);
    expect(report.blocked).toBe(true);
    expect(ctx.out.lines.join('\n')).toContain('BLOCKED');
    await expect(upgradeCheck(ctx, repo, { strict: true })).rejects.toMatchObject({
      exitCode: ExitCode.refused,
    });
    expect((await upgradeCheck(ctx, repo, { to: '1.0.1' })).blocked).toBe(false);
  });

  it('emits JSON when asked', async () => {
    await upgradeCheck(ctx, repo, { json: true });
    const json = JSON.parse(ctx.out.lines.at(-1) ?? '{}');
    expect(json.target).toBe('1.1.0');
  });

  it('requires a pinned Base version', async () => {
    writeFileSync(join(fx.instance, '.sold/base-version'), 'main\n');
    await expect(upgradeCheck(ctx, repo)).rejects.toThrow(/exact SemVer/);
  });

  it('computes available versions from tags', () => {
    expect(
      versionsAvailable(
        ['base-v1.0.0', 'base-v1.2.0', 'base-v1.10.0', 'base-vjunk', 'base-v2.0.0-rc.1'],
        '1.0.0',
        false,
      ),
    ).toEqual(['1.2.0', '1.10.0', '2.0.0-rc.1']);
    expect(versionsAvailable(['base-v1.0.1', 'base-v1.1.0'], '1.0.0', true)).toEqual(['1.0.1']);
  });
});

describe('upgrade:plan', () => {
  it('creates upgrade/base-v<version>, takes upstream Base-owned files, removes retired ones and keeps customer files', async () => {
    const result = await upgradePlan(ctx, repo, { version: '1.1.0' });

    expect(result.branch).toBe('upgrade/base-v1.1.0');
    expect(upgradeBranchName('1.1.0')).toBe(result.branch);
    expect(git(fx.instance, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('upgrade/base-v1.1.0');
    expect(git(fx.instance, 'status', '--porcelain')).toBe('');
    expect(git(fx.instance, 'log', '-1', '--format=%s')).toBe('chore(upgrade): base v1.1.0');

    // Base-owned: replaced from upstream
    expect(read('apps/web/a.ts')).toBe('export const a = 2;\n');
    expect(exists('apps/web/new.ts')).toBe(true);
    expect(exists('upgrades/1.1.0/001-rename.ts')).toBe(true);
    expect(read('CHANGELOG.md')).toContain('## 1.1.0');
    // retired upstream: removed
    expect(exists('packages/core/old.ts')).toBe(false);
    expect(result.removed).toEqual(['packages/core/old.ts']);
    // customer-owned and generated: untouched / rewritten by tooling
    expect(read('sold.config.ts')).toBe('// the customer edited this\n');
    expect(exists('extensions/loyalty/package.json')).toBe(true);
    expect(read('docs/instance/notes.md')).toBe('customer notes\n');
    expect(read('.sold/base-version')).toBe('1.1.0\n');
  });

  it('runs the codemods of every release in (from, to], in order, with from/to in the environment', async () => {
    const result = await upgradePlan(ctx, repo, { version: '1.1.0' });
    expect(result.codemods).toEqual([
      'upgrades/1.1.0/001-rename.ts',
      'upgrades/1.1.0/002-config.ts',
    ]);
    const codemodCalls = ctx.runner.calls.filter((c) => c.command === 'pnpm');
    expect(codemodCalls.map((c) => c.args.join(' '))).toEqual([
      'exec tsx upgrades/1.1.0/001-rename.ts',
      'exec tsx upgrades/1.1.0/002-config.ts',
    ]);
    expect(codemodCalls[0]?.options?.env).toMatchObject({
      SOLD_UPGRADE_FROM: '1.0.0',
      SOLD_UPGRADE_TO: '1.1.0',
    });
    // the codemod's output is part of the upgrade commit
    expect(read('apps/web/codemod-output.ts')).toContain('from 1.0.0 to 1.1.0');
    expect(git(fx.instance, 'ls-files', 'apps/web/codemod-output.ts')).toBe(
      'apps/web/codemod-output.ts',
    );
  });

  it('writes docs/instance/upgrades/<version>.md with tagged changes, compatibility and codemods', async () => {
    const result = await upgradePlan(ctx, repo, { version: '1.1.0' });
    expect(result.reportPath).toBe('docs/instance/upgrades/1.1.0.md');
    const report = read(result.reportPath);
    expect(report).toContain('# Upgrade to Base 1.1.0');
    expect(report).toContain('### breaking');
    expect(report).toContain('Removed the legacy cart API');
    expect(report).toContain('### migration');
    expect(report).toContain('| @demo/loyalty | >=1.0.0 <2.0.0 | compatible |');
    expect(report).toContain('`upgrades/1.1.0/001-rename.ts`');
    expect(report).toContain('- removed (retired upstream): 1');
    expect(report).toContain('Reviewer checklist');
  });

  it('lists Base-owned files the customer had edited (drift that this upgrade overwrites)', async () => {
    writeTree(fx.instance, { 'apps/web/a.ts': 'export const a = "customer edit";\n' });
    commitAll(fx.instance, 'customer edited a Base file');
    const result = await upgradePlan(ctx, repo, { version: '1.1.0' });
    expect(result.overwrittenCustomerEdits).toEqual(['apps/web/a.ts']);
    expect(read(result.reportPath)).toContain(
      'Local edits to Base-owned files that were overwritten',
    );
    expect(read('apps/web/a.ts')).toBe('export const a = 2;\n');
  });

  it('supports patch-only upgrades and refuses a non-patch target under --patch-only', async () => {
    await expect(upgradePlan(ctx, repo, { version: '1.1.0', patchOnly: true })).rejects.toThrow(
      /not a patch release/,
    );
    const result = await upgradePlan(ctx, repo, { version: '1.0.1', patchOnly: true });
    expect(result.codemods).toEqual([]);
    expect(read('apps/web/a.ts')).toBe('export const a = 1.0001;\n');
  });

  it('refuses a dirty working tree, an older target, a missing tag and an existing branch', async () => {
    writeTree(fx.instance, { 'docs/instance/notes.md': 'uncommitted\n' });
    await expect(upgradePlan(ctx, repo, { version: '1.1.0' })).rejects.toMatchObject({
      exitCode: ExitCode.refused,
    });
    git(fx.instance, 'checkout', '--', '.');

    await expect(upgradePlan(ctx, repo, { version: '1.0.0' })).rejects.toThrow(/not newer/);
    await expect(upgradePlan(ctx, repo, { version: '9.9.9' })).rejects.toThrow(
      /tag base-v9.9.9 not found/,
    );
    await expect(upgradePlan(ctx, repo, { version: 'latest' })).rejects.toMatchObject({
      exitCode: ExitCode.usage,
    });

    git(fx.instance, 'branch', 'upgrade/base-v1.1.0');
    await expect(upgradePlan(ctx, repo, { version: '1.1.0' })).rejects.toThrow(/already exists/);
  });

  it('leaves the changes uncommitted with --no-commit', async () => {
    const result = await upgradePlan(ctx, repo, { version: '1.1.0', noCommit: true });
    expect(result.committed).toBe(false);
    expect(git(fx.instance, 'status', '--porcelain')).not.toBe('');
    expect(git(fx.instance, 'log', '-1', '--format=%s')).toBe('instance setup');
  });

  it('a failing codemod leaves the branch uncommitted for inspection and reports which codemod failed', async () => {
    ctx.runner.on((c, a) => c === 'pnpm' && a[2] === 'upgrades/1.1.0/002-config.ts', {
      code: 1,
      stderr: 'boom: cannot rewrite sold.config.ts',
    });
    await expect(upgradePlan(ctx, repo, { version: '1.1.0' })).rejects.toThrow(
      /002-config.ts failed[\s\S]*boom/,
    );
    expect(git(fx.instance, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('upgrade/base-v1.1.0');
    expect(git(fx.instance, 'log', '-1', '--format=%s')).toBe('instance setup');
    expect(ctx.out.warnings.join('\n')).toContain('upgrade preparation failed');
  });

  it('--dry-run prints the plan and changes nothing', async () => {
    const dry = makeContext({ cwd: fx.instance, runner: ctx.runner, dryRun: true });
    const result = await upgradePlan(dry, repo, { version: '1.1.0' });
    expect(result.committed).toBe(false);
    expect(git(fx.instance, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(fx.instance, 'status', '--porcelain')).toBe('');
    expect(git(fx.instance, 'branch', '--list', 'upgrade/*')).toBe('');
    expect(ctx.runner.calls.filter((c) => c.command === 'pnpm')).toHaveLength(0);
    const text = dry.out.lines.join('\n');
    expect(text).toContain('[dry-run] git checkout -b upgrade/base-v1.1.0');
    expect(text).toContain('[dry-run] run codemod upgrades/1.1.0/001-rename.ts');
    expect(text).toContain('[dry-run] write docs/instance/upgrades/1.1.0.md');
  });
});

describe('upgrade:apply', () => {
  it('runs the gates in CI order and points at the PR workflow', async () => {
    await upgradePlan(ctx, repo, { version: '1.1.0' });
    ctx.runner.calls.length = 0;
    const result = await upgradeApply(ctx, repo);
    expect(result).toEqual({ branch: 'upgrade/base-v1.1.0', version: '1.1.0', pushed: false });
    expect(ctx.runner.lines().filter((l) => l.startsWith('pnpm'))).toEqual([
      'pnpm install',
      'pnpm typecheck',
      'pnpm lint',
      'pnpm test',
      'pnpm db:lint-migrations',
    ]);
    expect(upgradeGates()).toHaveLength(5);
  });

  it('stops at the first failing gate', async () => {
    await upgradePlan(ctx, repo, { version: '1.1.0' });
    ctx.runner.on('pnpm lint', { code: 1, stderr: 'lint errors' });
    await expect(upgradeApply(ctx, repo)).rejects.toThrow(/pnpm lint failed/);
    expect(ctx.runner.find('pnpm test')).toBeUndefined();
  });

  it('commits a refreshed lockfile and pushes when asked', async () => {
    await upgradePlan(ctx, repo, { version: '1.1.0' });
    ctx.runner.on('git push', { code: 0 });
    ctx.runner.on('pnpm install', () => {
      writeFileSync(join(fx.instance, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
      return { code: 0, stdout: '', stderr: '' };
    });
    const result = await upgradeApply(ctx, repo, { push: true });
    expect(result.pushed).toBe(true);
    expect(git(fx.instance, 'log', '-1', '--format=%s')).toBe('chore(upgrade): refresh lockfile');
    expect(ctx.runner.lines().at(-1)).toBe('git push -u origin upgrade/base-v1.1.0');
  });

  it('refuses outside an upgrade branch, with a stale version file, a missing report, uncommitted changes or incompatible extensions', async () => {
    await expect(upgradeApply(ctx, repo)).rejects.toThrow(/upgrade\/base-v<version> branch/);

    await upgradePlan(ctx, repo, { version: '1.1.0' });
    writeTree(fx.instance, {
      'extensions/loyalty/package.json': JSON.stringify({
        name: '@demo/loyalty',
        sold: { requires: { base: '^1.0.0 <1.1.0' } },
      }),
    });
    await expect(upgradeApply(ctx, repo)).rejects.toThrow(/uncommitted/);
    commitAll(fx.instance, 'tighten extension range');
    await expect(upgradeApply(ctx, repo)).rejects.toThrow(/incompatible with Base 1.1.0/);
    git(fx.instance, 'reset', '-q', '--hard', 'HEAD~1');

    writeFileSync(join(fx.instance, '.sold/base-version'), '1.0.5\n');
    commitAll(fx.instance, 'wrong version');
    await expect(upgradeApply(ctx, repo)).rejects.toThrow(/does not match/);
    git(fx.instance, 'reset', '-q', '--hard', 'HEAD~1');

    git(fx.instance, 'rm', '-q', 'docs/instance/upgrades/1.1.0.md');
    commitAll(fx.instance, 'drop report');
    await expect(upgradeApply(ctx, repo)).rejects.toThrow(/report|missing/);
  });

  it('--skip-gates warns loudly', async () => {
    await upgradePlan(ctx, repo, { version: '1.1.0' });
    ctx.runner.calls.length = 0;
    await upgradeApply(ctx, repo, { skipGates: true });
    expect(ctx.runner.calls.filter((c) => c.command !== 'git')).toHaveLength(0);
    expect(ctx.out.warnings.join('\n')).toContain('gates skipped');
  });

  it('--dry-run prints the gates and does not run them', async () => {
    await upgradePlan(ctx, repo, { version: '1.1.0' });
    const dry = makeContext({ cwd: fx.instance, runner: ctx.runner, dryRun: true });
    ctx.runner.calls.length = 0;
    await upgradeApply(dry, repo, { push: true });
    expect(
      ctx.runner.calls.filter((c) => c.command !== 'git' || c.args[0] === 'push'),
    ).toHaveLength(0);
    expect(dry.out.lines.join('\n')).toContain('[dry-run] run: pnpm typecheck');
    expect(dry.out.lines.join('\n')).toContain(
      '[dry-run] run: git push -u origin upgrade/base-v1.1.0',
    );
  });
});

describe('drift:check', () => {
  const branchWith = (name: string, files: Record<string, string>): void => {
    git(fx.instance, 'checkout', '-q', '-b', name, 'main');
    writeTree(fx.instance, files);
    commitAll(fx.instance, `change on ${name}`);
  };

  it('is a no-op outside instance repositories (Base edits its own paths)', async () => {
    git(fx.instance, 'rm', '-q', '.sold/instance.json');
    commitAll(fx.instance, 'not an instance');
    const result = await driftCheck(ctx, repo, { baseRef: 'main' });
    expect(result.skipped).toBe(true);
    expect(await driftCheck(ctx, repo, { baseRef: 'main', force: true })).toMatchObject({
      skipped: false,
    });
  });

  it('passes when only customer-owned or unowned paths change', async () => {
    branchWith('feature/loyalty', {
      'extensions/loyalty/index.ts': 'x',
      'docs/instance/notes.md': 'y',
      'README.md': 'z',
    });
    const result = await driftCheck(ctx, repo, { baseRef: 'main', branch: 'feature/loyalty' });
    expect(result).toMatchObject({ skipped: false, drifted: [], changed: 3 });
  });

  it('fails when a Base-owned path changes outside an upgrade branch', async () => {
    branchWith('feature/hack', {
      'apps/web/a.ts': 'export const a = "hacked";\n',
      'extensions/x/index.ts': 'ok',
    });
    await expect(
      driftCheck(ctx, repo, { baseRef: 'main', branch: 'feature/hack' }),
    ).rejects.toMatchObject({
      exitCode: ExitCode.refused,
    });
    expect(ctx.out.errors.join('\n')).toContain('apps/web/a.ts');
    expect(ctx.out.errors.join('\n')).not.toContain('extensions/x/index.ts');
  });

  it('allows Base-owned changes on upgrade/* branches', async () => {
    branchWith('upgrade/base-v1.1.0', { 'apps/web/a.ts': 'export const a = 2;\n' });
    const result = await driftCheck(ctx, repo, { baseRef: 'main', branch: 'upgrade/base-v1.1.0' });
    expect(result).toMatchObject({ onUpgradeBranch: true, drifted: [] });
  });

  it('reads ownership from the BASE ref, so a PR cannot un-own the files it edits', async () => {
    branchWith('feature/sneaky', {
      'apps/web/a.ts': 'export const a = "sneaky";\n',
      '.sold/base-manifest.json': JSON.stringify({
        schemaVersion: 1,
        baseOwned: ['nothing/**'],
        customerOwned: ['apps/**'],
      }),
    });
    await expect(
      driftCheck(ctx, repo, { baseRef: 'main', branch: 'feature/sneaky' }),
    ).rejects.toThrow(/Base-owned file/);
    expect(ctx.out.errors.join('\n')).toContain('.sold/base-manifest.json');
  });

  it('uses GITHUB_HEAD_REF when no branch is given, and fails clearly when the base ref is missing', async () => {
    branchWith('upgrade/base-v1.1.0', { 'apps/web/a.ts': 'x' });
    const inCi = makeContext({
      cwd: fx.instance,
      runner: ctx.runner,
      env: { GITHUB_HEAD_REF: 'upgrade/base-v1.1.0' },
    });
    expect(await driftCheck(inCi, repo, { baseRef: 'main' })).toMatchObject({
      onUpgradeBranch: true,
    });
    await expect(driftCheck(ctx, repo, { baseRef: 'origin/nope', branch: 'x' })).rejects.toThrow(
      /fetch it first/,
    );
  });
});
