import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { CliContext } from '../lib/context';
import { CliError, ExitCode } from '../lib/errors';
import { customerSchema } from '../env/ids';
import { PLACEHOLDER_DIGEST, serializeRelease, type ReleaseJson } from '../release/schemas';
import { instanceMarkerSchema } from '../upgrade/drift';
import { readTemplate, renderTemplate, renderTerraformEnvironment } from './render';

export interface CustomerNewOptions {
  name: string;
  /** Display name of the business; default: the customer slug capitalised. */
  displayName?: string;
  dir?: string;
  baseVersion?: string;
  upstream?: string;
}

export interface CustomerNewResult {
  dir: string;
  files: string[];
}

const ENVIRONMENTS = ['dev', 'stage', 'prod'] as const;

/**
 * Generates the customer-owned overlay of a new instance repository: instance config, per-environment
 * config overlays and release records, the customer's Terraform environment roots, the ownership
 * marker and the pinned Base version. Base-owned files arrive by cloning Base at `base-v<version>`.
 */
export async function customerNew(
  ctx: CliContext,
  options: CustomerNewOptions,
): Promise<CustomerNewResult> {
  const parsed = customerSchema.safeParse(options.name);
  if (!parsed.success)
    throw new CliError(parsed.error.issues[0]?.message ?? 'invalid customer name', ExitCode.usage);
  const customer = parsed.data;

  const baseVersion =
    options.baseVersion ??
    (await readFile(join(ctx.cwd, '.sold', 'base-version'), 'utf8').catch(() => '')).trim();
  if (!baseVersion)
    throw new CliError(
      'cannot determine the Base version: pass --base-version <x.y.z>',
      ExitCode.usage,
    );

  const dir = resolve(ctx.cwd, options.dir ?? join('..', `sold-${customer}`));
  const files = await renderFiles(
    customer,
    options.displayName ?? `${customer[0]?.toUpperCase() ?? ''}${customer.slice(1)}`,
    baseVersion,
    options.upstream,
  );

  const names = Object.keys(files).sort();
  if (ctx.dryRun) {
    ctx.out.info(`[dry-run] would create ${names.length} file(s) in ${dir}:`);
    for (const n of names) ctx.out.info(`[dry-run]   ${n}`);
    return { dir, files: names };
  }

  const existing = await readdir(dir).catch(() => [] as string[]);
  if (existing.length > 0) throw new CliError(`${dir} exists and is not empty`, ExitCode.refused);

  for (const name of names) {
    const target = join(dir, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, files[name] ?? '');
  }
  ctx.out.info(`created ${names.length} file(s) in ${dir}`);
  ctx.out.info('next steps:');
  ctx.out.info(
    `  1. start the instance repository from Base:  git clone <base-repo> ${dir}-base --branch base-v${baseVersion}`,
  );
  ctx.out.info(
    `     then copy ${dir} over it (or use it as the overlay of a fork) and add the 'upstream' remote`,
  );
  ctx.out.info(
    "  2. run the customer bootstrap (ops/terraform/bootstrap/customer) with the customer's subscriptions",
  );
  ctx.out.info(
    '  3. set the repository variables printed by the bootstrap, then `pnpm sold env:up`',
  );
  return { dir, files: names };
}

async function renderFiles(
  customer: string,
  displayName: string,
  baseVersion: string,
  upstream?: string,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const values = { customer, name: displayName };

  files['sold.config.ts'] = renderTemplate(
    await readTemplate('instance/sold.config.ts.tpl'),
    values,
  );
  files['docs/instance/README.md'] = renderTemplate(
    await readTemplate('instance/README.md.tpl'),
    values,
  );
  files['.github/workflows/instance-drift.yml'] = await readTemplate(
    'instance/instance-drift.yml.tpl',
  );
  files['extensions/.gitkeep'] = '';
  files['.sold/base-version'] = `${baseVersion}\n`;
  files['.sold/instance.json'] = `${JSON.stringify(
    instanceMarkerSchema.parse({
      customer,
      ...(upstream ? { upstream } : {}),
      createdWithBaseVersion: baseVersion,
    }),
    null,
    2,
  )}\n`;

  for (const environment of ENVIRONMENTS) {
    files[`config/${environment}.ts`] = renderConfigOverlay(
      await readTemplate('instance/config-overlay.ts.tpl'),
      environment,
    );
    files[`environments/${environment}/release.json`] = serializeRelease(
      placeholderRelease(baseVersion),
    );
  }
  for (const environment of [...ENVIRONMENTS, 'ephemeral'] as const) {
    const rendered = await renderTerraformEnvironment({ customer, environment });
    for (const [file, content] of Object.entries(rendered)) {
      files[`ops/terraform/environments/${customer}/${environment}/${file}`] = content;
    }
  }
  return files;
}

export function renderConfigOverlay(template: string, environment: string): string {
  const note =
    environment === 'prod'
      ? ' * Production: enable the waiting room only for scheduled events (`scale.waitingRoom`).\n'
      : environment === 'stage'
        ? ' * Stage mirrors production shape; keep differences minimal so load tests stay meaningful.\n'
        : ' * Dev is the shared integration environment; non-production safety switches are applied by profile.\n';
  return renderTemplate(template, { environment, overlay_note: note.replace(/\n$/, '') });
}

/** A new instance has built nothing yet: the digest is an obvious placeholder that `promote` refuses. */
function placeholderRelease(baseVersion: string): ReleaseJson {
  return {
    baseVersion,
    instanceBuild: 0,
    imageDigest: PLACEHOLDER_DIGEST,
    extensionVersions: {},
    terraformModuleVersion: baseVersion,
  };
}
