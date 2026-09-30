import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { CliContext } from '../lib/context';
import { CliError, ExitCode } from '../lib/errors';
import { classify, MANIFEST_PATH, parseManifest, type BaseManifest } from './manifest';
import type { Git } from './git';

export const INSTANCE_MARKER = '.sold/instance.json';

/** `.sold/instance.json`: present only in customer instance repositories. */
export const instanceMarkerSchema = z
  .object({
    customer: z.string().min(1),
    upstream: z.string().optional(),
    createdWithBaseVersion: z.string().min(1),
  })
  .strict();

export interface DriftOptions {
  /** Ref the change is compared against (default `origin/main`). */
  baseRef?: string;
  /** Branch name; default from GITHUB_HEAD_REF or git. */
  branch?: string;
  /** Run even without .sold/instance.json (Base's own repository legitimately edits Base paths). */
  force?: boolean;
}

export interface DriftResult {
  skipped: boolean;
  onUpgradeBranch: boolean;
  drifted: string[];
  changed: number;
}

/**
 * Ownership drift: in an instance repository, changing a Base-owned path is only legitimate on an
 * `upgrade/*` branch created by `upgrade:plan`. The manifest is read from the BASE ref, so a change
 * cannot quietly un-own the paths it edits.
 */
export async function driftCheck(
  ctx: CliContext,
  git: Git,
  options: DriftOptions = {},
): Promise<DriftResult> {
  let isInstance = options.force === true;
  if (!isInstance) {
    try {
      instanceMarkerSchema.parse(
        JSON.parse(await readFile(join(ctx.cwd, INSTANCE_MARKER), 'utf8')),
      );
      isInstance = true;
    } catch {
      isInstance = false;
    }
  }
  if (!isInstance) {
    ctx.out.info(
      `not an instance repository (${INSTANCE_MARKER} missing): Base edits its own paths, nothing to check`,
    );
    return { skipped: true, onUpgradeBranch: false, drifted: [], changed: 0 };
  }

  const branch = options.branch ?? ctx.env['GITHUB_HEAD_REF'] ?? (await git.currentBranch());
  const baseRef = options.baseRef ?? 'origin/main';
  if (!(await git.refExists(baseRef))) {
    throw new CliError(
      `cannot compare against '${baseRef}': fetch it first (in CI use fetch-depth: 0)`,
    );
  }
  const changed =
    (await git.lines([
      '-c',
      'core.quotepath=false',
      'diff',
      '--name-only',
      `${baseRef}...HEAD`,
      '--',
    ])) ?? [];

  if (branch.startsWith('upgrade/')) {
    ctx.out.info(
      `on ${branch}: Base-owned paths may change here (${changed.length} file(s) changed)`,
    );
    return { skipped: false, onUpgradeBranch: true, drifted: [], changed: changed.length };
  }

  const manifestText =
    (await git.show(baseRef, MANIFEST_PATH)) ??
    (await readFile(join(ctx.cwd, MANIFEST_PATH), 'utf8'));
  const manifest: BaseManifest = parseManifest(manifestText, MANIFEST_PATH);
  const drifted = changed.filter((f) => classify(f, manifest) === 'base');

  if (drifted.length > 0) {
    ctx.out.error(
      `ownership drift: ${drifted.length} Base-owned file(s) changed outside an upgrade/* branch:`,
    );
    for (const f of drifted) ctx.out.error(`  - ${f}`);
    ctx.out.error(
      'Base-owned paths are replaced on upgrade, so edits here are lost or conflict. Move the change into an ' +
        'extension (extensions/) or sold.config.ts, or propose it upstream. To take Base changes use `sold upgrade:plan`.',
    );
    throw new CliError(
      `${drifted.length} Base-owned file(s) modified outside an upgrade branch`,
      ExitCode.refused,
    );
  }
  ctx.out.info(`no ownership drift (${changed.length} file(s) changed, none Base-owned)`);
  return { skipped: false, onUpgradeBranch: false, drifted: [], changed: changed.length };
}
