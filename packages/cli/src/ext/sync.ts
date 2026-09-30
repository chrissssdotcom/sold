import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  discoverExtensions,
  DiscoveryError,
  renderRegistryModule,
} from '@sold/core/extensions/discovery';
import type { SoldConfig } from '@sold/core/config';
import type { CliContext } from '../lib/context';
import { CliError, ExitCode } from '../lib/errors';

/** Where the web app and the worker import the extension registry from (a build artifact, never committed). */
export const DEFAULT_REGISTRY_PATH = 'apps/web/.generated/extensions.ts';

/** `sold ext:sync`: write the static registry module for the extensions configured in `sold.config.ts`. */
export async function extSync(
  ctx: CliContext,
  options: { out?: string; loadConfig?: () => Promise<SoldConfig> } = {},
): Promise<{ written: string; extensions: string[] }> {
  const out = join(ctx.cwd, options.out ?? DEFAULT_REGISTRY_PATH);
  try {
    const result = await discoverExtensions(ctx.cwd, options.loadConfig);
    for (const w of result.warnings) ctx.out.warn(w);
    if (!ctx.dryRun) {
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, renderRegistryModule(result, out));
    }
    const names = result.extensions.map((e) => `${e.name}${e.enabled ? '' : ' (disabled)'}`);
    ctx.out.info(
      `${ctx.dryRun ? 'would write' : 'wrote'} ${options.out ?? DEFAULT_REGISTRY_PATH}: ${names.length === 0 ? 'no extensions' : names.join(', ')}`,
    );
    return { written: out, extensions: result.extensions.map((e) => e.name) };
  } catch (error) {
    if (error instanceof DiscoveryError) throw new CliError(error.message, ExitCode.failure);
    throw error;
  }
}
