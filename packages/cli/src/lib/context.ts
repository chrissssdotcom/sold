import type { ProcessRunner } from './process';
import type { AzureInventory, CloudflareInventory } from '../env/inventory';
import type { TierName } from '@sold/core/config';

export interface Output {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface InstanceConfig {
  customer: string;
  tier: TierName;
}

/** Everything a command needs from the outside world. Real in `bin.ts`, fakes in tests. */
export interface CliContext {
  /** Repository root (the instance repo, or Base itself). */
  cwd: string;
  env: Record<string, string | undefined>;
  runner: ProcessRunner;
  out: Output;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** True: print the exact actions, execute nothing. */
  dryRun: boolean;
  azure: AzureInventory;
  cloudflare: CloudflareInventory;
  loadInstanceConfig: (cwd: string) => Promise<InstanceConfig>;
}

export function createBufferOutput(): Output & {
  lines: string[];
  errors: string[];
  warnings: string[];
} {
  const lines: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  return {
    lines,
    errors,
    warnings,
    info: (m) => lines.push(m),
    warn: (m) => warnings.push(m),
    error: (m) => errors.push(m),
  };
}
