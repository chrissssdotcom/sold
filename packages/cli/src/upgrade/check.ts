import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import semver from 'semver';
import type { CliContext } from '../lib/context';
import { CliError, ExitCode } from '../lib/errors';
import { runStep } from '../lib/steps';
import type { Git } from './git';
import {
  entriesBetween,
  groupByTag,
  parseChangelog,
  type ChangeTag,
  type ChangelogEntry,
} from './changelog';
import { checkExtensionCompatibility, type ExtensionCompat } from './extensions';

export const BASE_TAG_PREFIX = 'base-v';
export const BASE_VERSION_PATH = '.sold/base-version';
export const DEFAULT_UPSTREAM = 'upstream';

export async function readBaseVersion(cwd: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(join(cwd, BASE_VERSION_PATH), 'utf8');
  } catch {
    throw new CliError(
      `${BASE_VERSION_PATH} not found: this repository is not pinned to a Base version`,
    );
  }
  const version = text.trim();
  if (semver.valid(version) !== version)
    throw new CliError(
      `${BASE_VERSION_PATH} must contain an exact SemVer version, got '${version}'`,
    );
  return version;
}

export interface UpgradeCheckOptions {
  /** Target version; default: the newest `base-v*` tag. */
  to?: string;
  upstream?: string;
  /** Skip `git fetch <upstream> --tags` (offline / already fetched). */
  fetch?: boolean;
  /** Only consider patch releases of the current minor. */
  patchOnly?: boolean;
  json?: boolean;
  /** Exit non-zero when an extension is incompatible with the target. */
  strict?: boolean;
}

export interface UpgradeCheckReport {
  current: string;
  target: string | undefined;
  available: string[];
  upToDate: boolean;
  changes: Record<ChangeTag, ChangelogEntry[]>;
  changelogFound: boolean;
  extensions: ExtensionCompat[];
  blocked: boolean;
}

export function versionsAvailable(tags: string[], current: string, patchOnly: boolean): string[] {
  return tags
    .map((t) => t.slice(BASE_TAG_PREFIX.length))
    .filter((v) => semver.valid(v) === v && semver.gt(v, current))
    .filter(
      (v) =>
        !patchOnly ||
        (semver.major(v) === semver.major(current) && semver.minor(v) === semver.minor(current)),
    )
    .sort(semver.compare);
}

export async function upgradeCheck(
  ctx: CliContext,
  git: Git,
  options: UpgradeCheckOptions = {},
): Promise<UpgradeCheckReport> {
  const current = await readBaseVersion(ctx.cwd);
  const upstream = options.upstream ?? DEFAULT_UPSTREAM;

  if (options.fetch !== false) {
    await runStep(ctx, {
      description: `fetch Base release tags from '${upstream}'`,
      command: 'git',
      args: ['fetch', upstream, '--tags', '--quiet'],
      allowFailure: true,
    });
  }

  const available = versionsAvailable(
    await git.tags(`${BASE_TAG_PREFIX}*`),
    current,
    options.patchOnly ?? false,
  );
  const target = options.to ?? available[available.length - 1];
  if (options.to && !available.includes(options.to)) {
    throw new CliError(
      `no ${BASE_TAG_PREFIX}${options.to} tag newer than ${current} is available (run without --to to see what is)`,
      ExitCode.usage,
    );
  }

  const empty: Record<ChangeTag, ChangelogEntry[]> = {
    breaking: [],
    migration: [],
    infra: [],
    security: [],
  };
  let changes = empty;
  let changelogFound = false;
  let extensions: ExtensionCompat[] = [];
  if (target) {
    const changelog = await git.show(`${BASE_TAG_PREFIX}${target}`, 'CHANGELOG.md');
    if (changelog !== undefined) {
      changelogFound = true;
      changes = groupByTag(entriesBetween(parseChangelog(changelog), current, target));
    }
    extensions = await checkExtensionCompatibility(ctx.cwd, target);
  }

  const blocked = extensions.some((e) => e.status === 'incompatible');
  const report: UpgradeCheckReport = {
    current,
    target,
    available,
    upToDate: target === undefined,
    changes,
    changelogFound,
    extensions,
    blocked,
  };
  printReport(ctx, report, options.json ?? false);
  if (options.strict && blocked) {
    throw new CliError(
      'one or more extensions are incompatible with the target Base version',
      ExitCode.refused,
    );
  }
  return report;
}

function printReport(ctx: CliContext, report: UpgradeCheckReport, json: boolean): void {
  if (json) {
    ctx.out.info(JSON.stringify(report, null, 2));
    return;
  }
  ctx.out.info(`current Base version: ${report.current}`);
  if (report.upToDate || !report.target) {
    ctx.out.info('up to date: no newer base-v* release is available');
    return;
  }
  ctx.out.info(`available: ${report.available.join(', ')}`);
  ctx.out.info(`target:    ${report.target}`);
  if (!report.changelogFound)
    ctx.out.warn(
      `no CHANGELOG.md found at ${BASE_TAG_PREFIX}${report.target}; cannot list tagged changes`,
    );
  for (const tag of ['breaking', 'migration', 'infra', 'security'] as const) {
    const entries = report.changes[tag];
    if (entries.length === 0) continue;
    ctx.out.info(`\n${tag.toUpperCase()} (${entries.length})`);
    for (const e of entries) ctx.out.info(`  ${e.version}  ${e.text}`);
  }
  if (report.extensions.length > 0) {
    ctx.out.info('\nextension compatibility');
    for (const e of report.extensions) {
      const detail = e.status === 'compatible' ? `requires base ${e.range}` : (e.reason ?? '');
      ctx.out.info(`  ${e.status.toUpperCase().padEnd(12)} ${e.name}  ${detail}`);
    }
  }
  ctx.out.info(
    report.blocked
      ? '\nBLOCKED: fix or update the incompatible extensions before running `sold upgrade:plan`'
      : `\nnext: sold upgrade:plan ${report.target}`,
  );
}
