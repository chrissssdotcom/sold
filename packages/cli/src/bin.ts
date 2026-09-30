#!/usr/bin/env -S npx tsx
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type { SoldConfig } from '@sold/core/config';
import { run } from './cli';
import { AzResourceGraphInventory, CloudflareApiInventory, type FetchLike } from './env/inventory';
import type { CliContext } from './lib/context';
import { NodeProcessRunner } from './lib/process';

function createContext({ dryRun }: { dryRun: boolean }): CliContext {
  const runner = new NodeProcessRunner();
  const env = process.env;
  const accountId = env['CLOUDFLARE_ACCOUNT_ID'];
  const zoneId = env['CLOUDFLARE_ZONE_ID'];
  return {
    cwd: process.cwd(),
    env,
    runner,
    out: {
      info: (m) => console.log(m),
      warn: (m) => console.warn(`warning: ${m}`),
      error: (m) => console.error(`error: ${m}`),
    },
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    dryRun,
    azure: new AzResourceGraphInventory(runner),
    cloudflare: new CloudflareApiInventory(
      fetch as unknown as FetchLike, // global fetch matches the narrow FetchLike shape used for GET requests
      env['CLOUDFLARE_API_TOKEN'],
      accountId ? { accountId, zoneId } : undefined,
    ),
    loadInstanceConfig: async (cwd) => {
      const module = (await import(pathToFileURL(join(cwd, 'sold.config.ts')).href)) as {
        default: SoldConfig;
      };
      return { customer: module.default.instance.customer, tier: module.default.tier };
    },
  };
}

// `pnpm sold <cmd>` runs with cwd = packages/cli; commands operate on the repository root.
process.exitCode = await run(process.argv.slice(2), {
  createContext: (flags) => {
    const context = createContext(flags);
    return { ...context, cwd: process.env['INIT_CWD'] ?? context.cwd };
  },
});
