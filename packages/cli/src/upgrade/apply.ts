import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { CliContext } from '../lib/context';
import { CliError, ExitCode } from '../lib/errors';
import { runStep, type Step } from '../lib/steps';
import { readBaseVersion } from './check';
import { checkExtensionCompatibility } from './extensions';
import type { Git } from './git';

const UPGRADE_BRANCH = /^upgrade\/base-v(.+)$/;

export interface UpgradeApplyOptions {
  /** Skip the verification gates (never in CI; for a laptop where they already ran). */
  skipGates?: boolean;
  /** Push the upgrade branch. The PR itself is opened by the workflow. */
  push?: boolean;
  remote?: string;
}

/** The gates an upgrade must pass before it can be proposed. Same commands as CI. */
export function upgradeGates(): Step[] {
  const gate = (description: string, args: string[]): Step => ({
    description,
    command: 'pnpm',
    args,
    stream: true,
  });
  return [
    gate('install dependencies (lockfile may change for extensions)', ['install']),
    gate('typecheck', ['typecheck']),
    gate('lint', ['lint']),
    gate('unit tests', ['test']),
    gate('migration safety lint', ['db:lint-migrations']),
  ];
}

export async function upgradeApply(
  ctx: CliContext,
  git: Git,
  options: UpgradeApplyOptions = {},
): Promise<{ branch: string; version: string; pushed: boolean }> {
  const branch = await git.currentBranch();
  const match = UPGRADE_BRANCH.exec(branch);
  if (!match?.[1]) {
    throw new CliError(
      `upgrade:apply runs on an upgrade/base-v<version> branch created by upgrade:plan; you are on '${branch}'`,
      ExitCode.refused,
    );
  }
  const version = match[1];
  const recorded = await readBaseVersion(ctx.cwd);
  if (recorded !== version) {
    throw new CliError(
      `${branch} does not match .sold/base-version (${recorded}); re-run upgrade:plan`,
      ExitCode.refused,
    );
  }
  const report = `docs/instance/upgrades/${version}.md`;
  try {
    await access(join(ctx.cwd, report));
  } catch {
    throw new CliError(`${report} is missing; run upgrade:plan first`, ExitCode.refused);
  }
  if (!(await git.isClean())) {
    throw new CliError(
      'the working tree has uncommitted changes; commit them before applying',
      ExitCode.refused,
    );
  }

  const incompatible = (await checkExtensionCompatibility(ctx.cwd, version)).filter(
    (e) => e.status === 'incompatible',
  );
  if (incompatible.length > 0) {
    throw new CliError(
      `extensions incompatible with Base ${version}:\n${incompatible.map((e) => `  ${e.name}: ${e.reason ?? ''}`).join('\n')}`,
      ExitCode.refused,
    );
  }

  if (!options.skipGates) {
    for (const gate of upgradeGates()) await runStep(ctx, gate);
    if (!ctx.dryRun && !(await git.isClean())) {
      // `pnpm install` may refresh the lockfile for extension dependencies: commit it with the upgrade.
      await git.run(['add', '-A']);
      await git.run(['commit', '-q', '-m', 'chore(upgrade): refresh lockfile']);
    }
  } else {
    ctx.out.warn('verification gates skipped (--skip-gates)');
  }

  let pushed = false;
  if (options.push) {
    await runStep(ctx, {
      description: `push ${branch}`,
      command: 'git',
      args: ['push', '-u', options.remote ?? 'origin', branch],
    });
    pushed = !ctx.dryRun;
  }
  ctx.out.info(
    `${branch} is ready. Open a PR titled "chore(upgrade): base v${version}" with ${report} as the body; ` +
      'the upgrade workflow does this on push.',
  );
  return { branch, version, pushed };
}
