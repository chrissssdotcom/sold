import semver from 'semver';
import { z } from 'zod';
import { customerSchema } from '../env/ids';

/** Exact SemVer without build metadata: `1.4.0`, `1.5.0-rc.1`. */
export const semverSchema = z.string().refine((v) => semver.valid(v) === v && !v.includes('+'), {
  message: 'must be an exact SemVer version without build metadata, e.g. 1.4.0',
});

export const digestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, 'must be an image digest: sha256:<64 hex>');

export const PLACEHOLDER_DIGEST = `sha256:${'0'.repeat(64)}`;

export function isPlaceholderDigest(digest: string): boolean {
  return digest === PLACEHOLDER_DIGEST;
}

/**
 * `environments/<env>/release.json`: the ONLY thing that differs between dev, stage and prod besides
 * config. Promotion copies this file; it never rebuilds anything (AGENTS.md principle 9).
 *
 * `imageDigest` is the web image. The Dockerfile has separate `web` and `worker` targets, so
 * `workerImageDigest` and `migrateImageDigest` are optional additions (deviation from the bare spec
 * shape, recorded in ADR-0003); when absent the web image is used for those roles.
 */
export const releaseJsonSchema = z
  .object({
    baseVersion: semverSchema,
    instanceBuild: z.number().int().nonnegative(),
    imageDigest: digestSchema,
    workerImageDigest: digestSchema.optional(),
    migrateImageDigest: digestSchema.optional(),
    extensionVersions: z.record(z.string().min(1), semverSchema),
    terraformModuleVersion: semverSchema,
  })
  .strict();

export type ReleaseJson = z.infer<typeof releaseJsonSchema>;

const VERSION_ID = /^([^+\s]+)\+([a-z][a-z0-9]{2,11})\.(\d+)$/;

export interface ParsedVersionId {
  baseVersion: string;
  customer: string;
  instanceBuild: number;
}

/** `<base-version>+<customer>.<instance-build>`, e.g. `1.4.0+demo.27` (SemVer build metadata). */
export const versionIdSchema = z.string().transform((value, ctx): ParsedVersionId => {
  const match = VERSION_ID.exec(value);
  const base = match?.[1];
  if (!match || !base || semver.valid(base) !== base) {
    ctx.addIssue({
      code: 'custom',
      message:
        'version id must look like <base-version>+<customer>.<instance-build>, e.g. 1.4.0+demo.27',
    });
    return z.NEVER;
  }
  const customer = customerSchema.safeParse(match[2]);
  if (!customer.success) {
    ctx.addIssue({ code: 'custom', message: 'version id has an invalid customer segment' });
    return z.NEVER;
  }
  return { baseVersion: base, customer: customer.data, instanceBuild: Number(match[3]) };
});

export function formatVersionId(
  customer: string,
  release: Pick<ReleaseJson, 'baseVersion' | 'instanceBuild'>,
): string {
  customerSchema.parse(customer);
  return `${release.baseVersion}+${customer}.${release.instanceBuild}`;
}

/** Stable key order and trailing newline so promotion diffs are minimal and reviewable. */
export function serializeRelease(release: ReleaseJson): string {
  const ordered: Record<string, unknown> = {
    baseVersion: release.baseVersion,
    instanceBuild: release.instanceBuild,
    imageDigest: release.imageDigest,
  };
  if (release.workerImageDigest) ordered['workerImageDigest'] = release.workerImageDigest;
  if (release.migrateImageDigest) ordered['migrateImageDigest'] = release.migrateImageDigest;
  ordered['extensionVersions'] = Object.fromEntries(
    Object.entries(release.extensionVersions).sort(([a], [b]) => a.localeCompare(b)),
  );
  ordered['terraformModuleVersion'] = release.terraformModuleVersion;
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
