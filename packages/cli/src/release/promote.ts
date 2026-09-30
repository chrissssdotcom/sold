import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import semver from 'semver';
import type { CliContext } from '../lib/context';
import { CliError, ExitCode } from '../lib/errors';
import { slugify } from '../env/ids';
import {
  formatVersionId,
  isPlaceholderDigest,
  releaseJsonSchema,
  serializeRelease,
  type ReleaseJson,
} from './schemas';

/** Promotion ladder. Only forward, only one rung at a time (unless deliberately overridden). */
export const promotionLadder = ['dev', 'stage', 'prod'] as const;
export type LadderEnvironment = (typeof promotionLadder)[number];

export function isLadderEnvironment(value: string): value is LadderEnvironment {
  return (promotionLadder as readonly string[]).includes(value);
}

export function releasePath(cwd: string, environment: string): string {
  return join(cwd, 'environments', environment, 'release.json');
}

export async function readRelease(
  cwd: string,
  environment: string,
): Promise<ReleaseJson | undefined> {
  let text: string;
  try {
    text = await readFile(releasePath(cwd, environment), 'utf8');
  } catch {
    return undefined;
  }
  const parsed = releaseJsonSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new CliError(
      `environments/${environment}/release.json is invalid:\n` +
        parsed.error.issues
          .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('\n'),
    );
  }
  return parsed.data;
}

export interface PromoteOptions {
  from: string;
  to: string;
  allowSkip?: boolean;
  /** Rollback: allow `to` to receive an older release than it currently has. */
  allowDowngrade?: boolean;
}

export interface PromotionResult {
  changed: boolean;
  versionId: string;
  from: LadderEnvironment;
  to: LadderEnvironment;
  previous: ReleaseJson | undefined;
  release: ReleaseJson;
  /** Suggested by the workflow that opens the PR (the CLI never opens PRs). */
  branch: string;
  title: string;
  body: string;
}

function compareReleases(a: ReleaseJson, b: ReleaseJson): number {
  const byBase = semver.compare(a.baseVersion, b.baseVersion);
  return byBase !== 0 ? byBase : a.instanceBuild - b.instanceBuild;
}

export async function promote(ctx: CliContext, options: PromoteOptions): Promise<PromotionResult> {
  const { from, to } = options;
  if (!isLadderEnvironment(from) || !isLadderEnvironment(to)) {
    throw new CliError(
      `promote works on ${promotionLadder.join(' -> ')}; got '${from}' -> '${to}'`,
      ExitCode.usage,
    );
  }
  const distance = promotionLadder.indexOf(to) - promotionLadder.indexOf(from);
  if (distance <= 0) {
    throw new CliError(
      `'${to}' is not after '${from}': releases only move forward (use --allow-downgrade for a rollback)`,
      ExitCode.refused,
    );
  }
  if (distance > 1 && !options.allowSkip) {
    throw new CliError(
      `refusing to promote ${from} -> ${to}: it would skip ${promotionLadder[promotionLadder.indexOf(from) + 1]}. ` +
        'Each release is proven in every rung; pass --allow-skip for a deliberate exception.',
      ExitCode.refused,
    );
  }

  const source = await readRelease(ctx.cwd, from);
  if (!source) throw new CliError(`environments/${from}/release.json does not exist`);
  if (isPlaceholderDigest(source.imageDigest)) {
    throw new CliError(
      `environments/${from}/release.json still carries the placeholder image digest: nothing has been built for ${from} yet`,
      ExitCode.refused,
    );
  }
  const previous = await readRelease(ctx.cwd, to);
  if (previous && compareReleases(source, previous) < 0 && !options.allowDowngrade) {
    throw new CliError(
      `${to} already runs a newer release (${previous.baseVersion} build ${previous.instanceBuild}) than ${from} ` +
        `(${source.baseVersion} build ${source.instanceBuild}). Pass --allow-downgrade for a deliberate rollback.`,
      ExitCode.refused,
    );
  }

  const { customer } = await ctx.loadInstanceConfig(ctx.cwd);
  const versionId = formatVersionId(customer, source);
  const changed = previous === undefined || serializeRelease(previous) !== serializeRelease(source);
  const branch = `promote/${to}-${slugify(versionId, 40)}`;
  const title = `chore(release): promote ${versionId} to ${to}`;
  const body = [
    `Promotes **${versionId}** from \`${from}\` to \`${to}\` by copying \`environments/${from}/release.json\`.`,
    'The image digest is unchanged: nothing is rebuilt.',
    '',
    `- image: \`${source.imageDigest}\``,
    `- previous ${to}: ${previous ? formatVersionId(customer, previous) : 'none'}`,
  ].join('\n');

  if (!changed) {
    ctx.out.info(`${to} already runs ${versionId}; nothing to promote`);
  } else if (ctx.dryRun) {
    ctx.out.info(`[dry-run] would write environments/${to}/release.json:`);
    ctx.out.info(serializeRelease(source).trimEnd());
    ctx.out.info(`[dry-run] the promotion PR would use branch ${branch} and title "${title}"`);
  } else {
    const path = releasePath(ctx.cwd, to);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serializeRelease(source));
    ctx.out.info(`wrote environments/${to}/release.json (${versionId})`);
    ctx.out.info(`open a PR from branch ${branch}: "${title}"`);
  }
  return { changed, versionId, from, to, previous, release: source, branch, title, body };
}

// ------------------------------------------------------------------------------------------------
// release:stamp (used by the release workflow after `build once`)
// ------------------------------------------------------------------------------------------------

export interface StampOptions {
  environment?: string;
  imageDigest: string;
  workerImageDigest?: string;
  migrateImageDigest?: string;
  baseVersion?: string;
  instanceBuild?: number;
}

/** Reads name and version from each extension package. Extensions version independently (SemVer). */
export async function collectExtensionVersions(cwd: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let entries: string[];
  try {
    entries = await readdir(join(cwd, 'extensions'));
  } catch {
    return out;
  }
  for (const entry of entries.sort()) {
    if (entry.startsWith('_') || entry.startsWith('.')) continue;
    try {
      const pkg = JSON.parse(
        await readFile(join(cwd, 'extensions', entry, 'package.json'), 'utf8'),
      ) as {
        name?: string;
        version?: string;
      };
      if (pkg.name && pkg.version && semver.valid(pkg.version)) out[pkg.name] = pkg.version;
    } catch {
      // not an extension package
    }
  }
  return out;
}

export async function stampRelease(ctx: CliContext, options: StampOptions): Promise<ReleaseJson> {
  const environment = options.environment ?? 'dev';
  if (environment !== 'dev') {
    throw new CliError(
      'builds are stamped into dev only; stage and prod receive releases by promotion',
      ExitCode.refused,
    );
  }
  const previous = await readRelease(ctx.cwd, environment);
  const baseVersion =
    options.baseVersion ?? (await readFile(join(ctx.cwd, '.sold', 'base-version'), 'utf8')).trim();
  const release = releaseJsonSchema.parse({
    baseVersion,
    instanceBuild: options.instanceBuild ?? (previous?.instanceBuild ?? 0) + 1,
    imageDigest: options.imageDigest,
    ...(options.workerImageDigest ? { workerImageDigest: options.workerImageDigest } : {}),
    ...(options.migrateImageDigest ? { migrateImageDigest: options.migrateImageDigest } : {}),
    extensionVersions: await collectExtensionVersions(ctx.cwd),
    // The Terraform modules ship with Base and are versioned with it.
    terraformModuleVersion: baseVersion,
  });
  const { customer } = await ctx.loadInstanceConfig(ctx.cwd);
  const versionId = formatVersionId(customer, release);
  if (ctx.dryRun) {
    ctx.out.info(`[dry-run] would stamp environments/${environment}/release.json as ${versionId}`);
    ctx.out.info(serializeRelease(release).trimEnd());
    return release;
  }
  const path = releasePath(ctx.cwd, environment);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeRelease(release));
  ctx.out.info(`stamped ${versionId}`);
  return release;
}
