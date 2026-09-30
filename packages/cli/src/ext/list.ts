import { BASE_VERSION } from '@sold/core';
import { discoverExtensions, DiscoveryError } from '@sold/core/extensions/discovery';
import { ExtensionLoadError, resolveLoadOrder } from '@sold/core/extensions';
import type { CliContext } from '../lib/context';
import { CliError, ExitCode } from '../lib/errors';

/**
 * `sold ext:list`: the resolved load order, or every reason it cannot boot (incompatible Base, missing or
 * disabled dependencies, cycles). The same check the app runs at boot, run ahead of time (and in CI).
 */
export async function extList(ctx: CliContext): Promise<void> {
  try {
    const found = await discoverExtensions(ctx.cwd);
    for (const w of found.warnings) ctx.out.warn(w);
    const order = resolveLoadOrder({
      baseVersion: BASE_VERSION,
      candidates: found.extensions.map((e) => ({ manifest: e.manifest, origin: e.origin })),
      entries: found.entries,
    });
    ctx.out.info(`Base ${BASE_VERSION}: ${order.length} extension(s) load in this order:`);
    for (const e of order) {
      ctx.out.info(
        `  ${e.index + 1}. ${e.manifest.name}@${e.manifest.version} [${e.origin}]${e.manifest.performance.hotPath ? ' (hot path)' : ''}`,
      );
    }
    const disabled = found.extensions.filter((e) => !e.enabled).map((e) => e.name);
    if (disabled.length > 0) ctx.out.info(`disabled: ${disabled.join(', ')}`);
  } catch (error) {
    if (error instanceof DiscoveryError || error instanceof ExtensionLoadError)
      throw new CliError(error.message, ExitCode.failure);
    throw error;
  }
}
