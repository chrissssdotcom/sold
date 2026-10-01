import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import semver from 'semver';
import type { CliContext } from '../lib/context';
import { CliError, ExitCode } from '../lib/errors';
import { runStep } from '../lib/steps';
import { BASE_TAG_PREFIX, BASE_VERSION_PATH, DEFAULT_UPSTREAM, readBaseVersion } from './check';
import { entriesBetween, groupByTag, parseChangelog, type ChangeTag } from './changelog';
import { checkExtensionCompatibility, type ExtensionCompat } from './extensions';
import type { Git } from './git';
import { chunk } from './git';
import {
  MANIFEST_PATH,
  matchesAny,
  parseManifest,
  readManifest,
  type BaseManifest,
} from './manifest';

export function upgradeBranchName(version: string): string {
  return `upgrade/base-v${version}`;
}

export interface UpgradePlanOptions {
  version: string;
  patchOnly?: boolean;
  upstream?: string;
  fetch?: boolean;
  /** Do not commit; leave the changes staged for inspection. */
  noCommit?: boolean;
  /** Skip the dependency install that follows replacing Base files (default: install). */
  noInstall?: boolean;
}

export interface UpgradePlanResult {
  branch: string;
  from: string;
  to: string;
  updated: string[];
  removed: string[];
  overwrittenCustomerEdits: string[];
  codemods: string[];
  extensions: ExtensionCompat[];
  reportPath: string;
  committed: boolean;
}

/**
 * Prepares the upgrade branch: takes upstream's version of every Base-owned path (per the TARGET
 * release's manifest), runs the release's codemods, records the base version and writes a report the
 * reviewer reads. It never touches customer-owned paths.
 */
export async function upgradePlan(
  ctx: CliContext,
  git: Git,
  options: UpgradePlanOptions,
): Promise<UpgradePlanResult> {
  const from = await readBaseVersion(ctx.cwd);
  const to = options.version;
  if (semver.valid(to) !== to)
    throw new CliError(`'${to}' is not an exact SemVer version`, ExitCode.usage);
  if (!semver.gt(to, from))
    throw new CliError(
      `target ${to} is not newer than the current Base version ${from}`,
      ExitCode.refused,
    );
  if (
    options.patchOnly &&
    (semver.major(to) !== semver.major(from) || semver.minor(to) !== semver.minor(from))
  ) {
    throw new CliError(`--patch-only: ${to} is not a patch release of ${from}`, ExitCode.refused);
  }

  const upstream = options.upstream ?? DEFAULT_UPSTREAM;
  const tag = `${BASE_TAG_PREFIX}${to}`;
  const branch = upgradeBranchName(to);

  if (!(await git.isClean())) {
    throw new CliError(
      `the working tree has uncommitted changes:\n  ${(await git.dirtyFiles()).slice(0, 10).join('\n  ')}\ncommit or stash them first`,
      ExitCode.refused,
    );
  }

  if (options.fetch !== false) {
    await runStep(ctx, {
      description: `fetch ${tag} from '${upstream}'`,
      command: 'git',
      args: ['fetch', upstream, '--tags', '--quiet'],
      allowFailure: true,
    });
  }
  if (!(await git.refExists(tag))) {
    if (ctx.dryRun) ctx.out.warn(`${tag} is not available locally; the real run fetches it first`);
    else
      throw new CliError(`tag ${tag} not found (fetched from '${upstream}'). Is ${to} released?`);
  }
  if (await git.refExists(`refs/heads/${branch}`)) {
    throw new CliError(
      `branch ${branch} already exists; delete it or continue the upgrade there`,
      ExitCode.refused,
    );
  }

  // Ownership comes from the target release: it may add or retire Base-owned paths.
  const targetManifestText = await git.show(tag, MANIFEST_PATH);
  const manifest: BaseManifest = targetManifestText
    ? parseManifest(targetManifestText, `${tag}:${MANIFEST_PATH}`)
    : await readManifest(ctx.cwd);

  const upstreamFiles = ((await git.refExists(tag)) ? await git.filesAt(tag) : []).filter((f) =>
    matchesAny(f, manifest.baseOwned),
  );
  const upstreamSet = new Set(upstreamFiles);
  const localBase = (await git.trackedFiles()).filter((f) => matchesAny(f, manifest.baseOwned));
  const removed = localBase.filter(
    (f) => !upstreamSet.has(f) && !matchesAny(f, manifest.generated),
  );

  // Customer edits to Base-owned files that this upgrade will overwrite (drift that slipped in).
  let overwrittenCustomerEdits: string[] = [];
  const currentTag = `${BASE_TAG_PREFIX}${from}`;
  if (await git.refExists(currentTag)) {
    const changedSinceBase =
      (await git.lines(
        ['-c', 'core.quotepath=false', 'diff', '--name-only', currentTag, 'HEAD', '--'],
        { allowFailure: true },
      )) ?? [];
    overwrittenCustomerEdits = changedSinceBase.filter((f) => matchesAny(f, manifest.baseOwned));
  }

  // Codemods shipped with the target release, for every release in (from, to].
  const codemodPlan: { version: string; file: string }[] = [];
  for (const version of await codemodVersions(git, tag, from, to)) {
    for (const file of upstreamFiles
      .filter((f) => f.startsWith(`upgrades/${version}/`) && f.endsWith('.ts'))
      .sort()) {
      codemodPlan.push({ version, file });
    }
  }

  const changelogText = await git.show(tag, 'CHANGELOG.md');
  const changes = changelogText
    ? groupByTag(entriesBetween(parseChangelog(changelogText), from, to))
    : undefined;
  const extensions = await checkExtensionCompatibility(ctx.cwd, to, {
    baseOwned: (path) => matchesAny(path, manifest.baseOwned),
  });
  const reportPath = `docs/instance/upgrades/${to}.md`;

  if (ctx.dryRun) {
    ctx.out.info(`[dry-run] git checkout -b ${branch}`);
    ctx.out.info(
      `[dry-run] take upstream (${tag}) for ${upstreamFiles.length} Base-owned file(s); remove ${removed.length} retired file(s)`,
    );
    ctx.out.info(`[dry-run] write ${BASE_VERSION_PATH} = ${to}`);
    if (!options.noInstall) ctx.out.info('[dry-run] run: pnpm install --no-frozen-lockfile');
    for (const c of codemodPlan) ctx.out.info(`[dry-run] run codemod ${c.file}`);
    ctx.out.info(`[dry-run] write ${reportPath}`);
    ctx.out.info(`[dry-run] git add -A && git commit -m "chore(upgrade): base v${to}"`);
    if (overwrittenCustomerEdits.length > 0) {
      ctx.out.warn(
        `Base-owned files edited since ${currentTag} would be overwritten: ${overwrittenCustomerEdits.join(', ')}`,
      );
    }
    return {
      branch,
      from,
      to,
      updated: upstreamFiles,
      removed,
      overwrittenCustomerEdits,
      codemods: codemodPlan.map((c) => c.file),
      extensions,
      reportPath,
      committed: false,
    };
  }

  await requireGit(git, ['checkout', '-b', branch]);
  try {
    for (const files of chunk(upstreamFiles, 100))
      await requireGit(git, ['checkout', tag, '--', ...files]);
    for (const files of chunk(removed, 100))
      await requireGit(git, ['rm', '-q', '--ignore-unmatch', '--', ...files]);
    await writeFile(join(ctx.cwd, BASE_VERSION_PATH), `${to}\n`);

    // The release brought new packages and dependencies. Without installing them the CLI itself cannot start again (it imports workspace
    // sources), so `upgrade:apply` would die before its own install step. Found by rehearsing against a tagged upstream.
    // Not frozen: the lockfile is regenerated for the new Base files plus this instance's extensions; `upgrade:apply` commits it.
    if (!options.noInstall) {
      ctx.out.info('installing dependencies for the new Base files');
      const install = await ctx.runner.run('pnpm', ['install', '--no-frozen-lockfile'], {
        cwd: ctx.cwd,
        stream: true,
      });
      if (install.code !== 0) {
        throw new CliError(
          `pnpm install failed (exit ${install.code}). The branch ${branch} is left uncommitted for inspection.\n${(install.stderr || install.stdout).trim().split('\n').slice(-6).join('\n')}`,
        );
      }
    }

    const codemodsRun: string[] = [];
    for (const codemod of codemodPlan) {
      const result = await ctx.runner.run('pnpm', ['exec', 'tsx', codemod.file], {
        cwd: ctx.cwd,
        env: { SOLD_UPGRADE_FROM: from, SOLD_UPGRADE_TO: to },
        stream: true,
      });
      if (result.code !== 0) {
        throw new CliError(
          `codemod ${codemod.file} failed (exit ${result.code}). The branch ${branch} is left uncommitted for inspection.\n${(result.stderr || result.stdout).trim().split('\n').slice(-6).join('\n')}`,
        );
      }
      codemodsRun.push(codemod.file);
    }

    const report = renderReport({
      from,
      to,
      tag,
      changes,
      extensions,
      updated: upstreamFiles,
      removed,
      overwrittenCustomerEdits,
      codemods: codemodsRun,
    });
    await mkdir(join(ctx.cwd, 'docs', 'instance', 'upgrades'), { recursive: true });
    await writeFile(join(ctx.cwd, reportPath), report);

    let committed = false;
    if (!options.noCommit) {
      await requireGit(git, ['add', '-A']);
      await requireGit(git, [
        'commit',
        '-q',
        '-m',
        `chore(upgrade): base v${to}`,
        '-m',
        `Takes ${tag} for Base-owned paths. See ${reportPath}.`,
      ]);
      committed = true;
    }
    ctx.out.info(
      `prepared ${branch}: ${upstreamFiles.length} file(s) from ${tag}, ${removed.length} removed, ${codemodsRun.length} codemod(s)`,
    );
    ctx.out.info(`review ${reportPath}, then run: sold upgrade:apply`);
    return {
      branch,
      from,
      to,
      updated: upstreamFiles,
      removed,
      overwrittenCustomerEdits,
      codemods: codemodsRun,
      extensions,
      reportPath,
      committed,
    };
  } catch (error) {
    ctx.out.warn(
      `upgrade preparation failed; you are on ${branch}. Fix the problem, or go back with: git checkout - && git branch -D ${branch}`,
    );
    throw error;
  }
}

async function requireGit(git: Git, args: string[]): Promise<void> {
  await git.run(args);
}

/** Versions in (from, to] that ship codemods, ascending. Directory names under `upgrades/` at the target tag. */
async function codemodVersions(git: Git, tag: string, from: string, to: string): Promise<string[]> {
  if (!(await git.refExists(tag))) return [];
  const dirs = new Set<string>();
  for (const f of await git.filesAt(tag)) {
    const m = /^upgrades\/([^/]+)\//.exec(f);
    if (m?.[1]) dirs.add(m[1]);
  }
  return [...dirs]
    .filter((v) => semver.valid(v) === v && semver.gt(v, from) && semver.lte(v, to))
    .sort(semver.compare);
}

interface ReportInput {
  from: string;
  to: string;
  tag: string;
  changes: Record<ChangeTag, { version: string; text: string }[]> | undefined;
  extensions: ExtensionCompat[];
  updated: string[];
  removed: string[];
  overwrittenCustomerEdits: string[];
  codemods: string[];
}

export function renderReport(input: ReportInput): string {
  const lines: string[] = [
    `# Upgrade to Base ${input.to}`,
    '',
    `Generated by \`sold upgrade:plan\`. From **${input.from}** to **${input.to}** (\`${input.tag}\`). Do not edit by hand: re-run the plan.`,
    '',
    '## Tagged changes',
    '',
  ];
  const order: ChangeTag[] = ['breaking', 'migration', 'infra', 'security'];
  if (!input.changes) {
    lines.push(
      'No CHANGELOG.md was found at the target tag, so tagged changes could not be listed.',
      '',
    );
  } else {
    let any = false;
    for (const tag of order) {
      const entries = input.changes[tag];
      if (entries.length === 0) continue;
      any = true;
      lines.push(`### ${tag}`, '', ...entries.map((e) => `- (${e.version}) ${e.text}`), '');
    }
    if (!any) lines.push('No entries tagged breaking, migration, infra or security.', '');
  }
  lines.push('## Extension compatibility', '');
  if (input.extensions.length === 0) lines.push('No extensions installed.', '');
  else {
    lines.push('| Extension | Requires base | Status |', '| --- | --- | --- |');
    for (const e of input.extensions)
      lines.push(
        `| ${e.name} | ${e.range ?? 'not declared'} | ${e.status}${e.reason ? ` (${e.reason})` : ''} |`,
      );
    lines.push('');
  }
  lines.push(
    '## Base-owned files',
    '',
    `- taken from upstream: ${input.updated.length}`,
    `- removed (retired upstream): ${input.removed.length}`,
  );
  if (input.removed.length > 0)
    lines.push(...input.removed.slice(0, 50).map((f) => `  - \`${f}\``));
  if (input.overwrittenCustomerEdits.length > 0) {
    lines.push(
      '',
      '### Local edits to Base-owned files that were overwritten',
      '',
      'These paths changed since the previous Base release and are Base-owned. Move the customisation into an extension.',
      '',
    );
    lines.push(...input.overwrittenCustomerEdits.map((f) => `- \`${f}\``));
  }
  lines.push('', '## Codemods', '');
  lines.push(
    ...(input.codemods.length === 0
      ? ['None shipped with this release.']
      : input.codemods.map((c) => `- \`${c}\``)),
  );
  lines.push(
    '',
    '## Reviewer checklist',
    '',
    '- [ ] Breaking and migration entries above are understood and handled',
    '- [ ] Extension compatibility is green (or the extension is updated in this PR)',
    '- [ ] `sold upgrade:apply` gates passed (typecheck, lint, tests, migration lint)',
    '- [ ] Preview environment verified, then dev, then stage (promotion PRs), then prod',
    '',
  );
  return lines.join('\n');
}
