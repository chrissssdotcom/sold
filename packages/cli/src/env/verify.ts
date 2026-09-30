import { formatCommand } from '../lib/process';
import type { CliContext } from '../lib/context';
import type { InventoryItem } from './inventory';

export interface VerifyResult {
  ok: boolean;
  leftovers: InventoryItem[];
  /** Things that could not be checked (never silently treated as "clean"). */
  warnings: string[];
}

export interface VerifyOptions {
  /** Fail (instead of warn) when Cloudflare credentials are missing. CI sets this. */
  requireCloudflare?: boolean;
}

/**
 * The definition of "the environment is really gone": nothing in Azure (resource graph, and
 * soft-deleted Key Vaults that would still reserve the name) and nothing in Cloudflare carries or is
 * named after the env-id. Anything found is a leftover and fails the run.
 */
export async function verifyEnvironmentRemoved(
  ctx: Pick<CliContext, 'azure' | 'cloudflare'>,
  envId: string,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const leftovers: InventoryItem[] = [];
  const warnings: string[] = [];

  leftovers.push(...(await ctx.azure.findResources(envId)));
  leftovers.push(...(await ctx.azure.findSoftDeletedKeyVaults(envId)));

  if (ctx.cloudflare.isConfigured()) {
    leftovers.push(...(await ctx.cloudflare.findByEnvId(envId)));
  } else {
    const message =
      'Cloudflare was NOT verified: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID are not set, so DNS, R2, Access, ' +
      'Turnstile and Waiting Room leftovers cannot be ruled out';
    if (options.requireCloudflare)
      leftovers.push({ source: 'cloudflare', kind: 'unverifiable', id: '-', name: message });
    else warnings.push(message);
  }

  return { ok: leftovers.length === 0, leftovers, warnings };
}

export function describeVerifyPlan(
  ctx: Pick<CliContext, 'azure' | 'cloudflare'>,
  envId: string,
): string[] {
  return [
    ...ctx.azure.describeVerifyQueries(envId),
    ...ctx.cloudflare.describeVerifyQueries(envId),
  ];
}

/** Remedy text for leftovers, so the operator sees the exact next command. */
export function remediationFor(item: InventoryItem): string | undefined {
  if (item.source === 'azure-soft-deleted-key-vault') {
    return `purge it: ${formatCommand('az', ['keyvault', 'purge', '--name', item.name])}`;
  }
  if (item.source === 'cloudflare' && item.kind === 'r2-bucket') {
    return 'empty the bucket (ops/terraform/scripts/r2-empty.sh) and delete it';
  }
  return undefined;
}
