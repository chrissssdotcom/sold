import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { EnvironmentName, TierName } from '@sold/core/config';
import { CliError, ExitCode } from '../lib/errors';
import { isEphemeralEnvironment, parseEnvId } from './ids';

/** Ladder profiles that Terraform environments can have (`local` is a laptop, not Azure). */
export type DeployProfile = Exclude<EnvironmentName, 'local'>;

export const deployProfiles: readonly DeployProfile[] = ['ephemeral', 'dev', 'stage', 'prod'];

export function isDeployProfile(value: string): value is DeployProfile {
  return (deployProfiles as readonly string[]).includes(value);
}

export interface ProfileInfo {
  /** Profile tfvars in ops/terraform/profiles. */
  tfvars: string;
  /** stage/prod take their capacity from a tier file; ephemeral/dev carry their own. */
  usesTier: boolean;
  /** The CLI may create/destroy/pause this profile. Production is changed only by a promotion PR. */
  cliManaged: boolean;
}

export const PROFILE_INFO: Record<DeployProfile, ProfileInfo> = {
  ephemeral: { tfvars: 'ephemeral.tfvars', usesTier: false, cliManaged: true },
  dev: { tfvars: 'dev.tfvars', usesTier: false, cliManaged: true },
  stage: { tfvars: 'stage.tfvars', usesTier: true, cliManaged: true },
  prod: { tfvars: 'prod.tfvars', usesTier: true, cliManaged: false },
};

export function tierTfvars(tier: TierName): string {
  return `tier-${tier}.tfvars`;
}

export function profilesDir(cwd: string): string {
  return join(cwd, 'ops', 'terraform', 'profiles');
}

/** Terraform root for an environment: one shared root for all ephemeral envs, one per persistent env. */
export function terraformRoot(cwd: string, customer: string, environment: string): string {
  const folder = isEphemeralEnvironment(environment) ? 'ephemeral' : environment;
  return join(cwd, 'ops', 'terraform', 'environments', customer, folder);
}

export function profileOfEnvironment(environment: string): DeployProfile {
  if (isEphemeralEnvironment(environment)) return 'ephemeral';
  if (environment === 'dev' || environment === 'stage' || environment === 'prod')
    return environment;
  throw new CliError(
    `cannot infer the profile of environment '${environment}': persistent environments are named dev, stage or prod; ` +
      'ephemeral ones start with eph-',
    ExitCode.usage,
  );
}

/**
 * Is this environment production? Checks, in order of authority: what Azure says (`sold:profile` tag),
 * the environment name, and what the repository configures (`profile = "prod"` in the Terraform root).
 * Any single signal is enough; nothing overrides it (there is deliberately no --force).
 */
export async function isProduction(args: {
  cwd: string;
  envId: string;
  taggedProfile?: string | undefined;
}): Promise<{ prod: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  if (args.taggedProfile === 'prod') reasons.push("Azure tag sold:profile is 'prod'");
  let parsed: { customer: string; environment: string } | undefined;
  try {
    parsed = parseEnvId(args.envId);
  } catch {
    parsed = undefined;
  }
  if (/(^|-)prod(uction)?(-|$)/.test(args.envId))
    reasons.push("the environment name contains 'prod'");
  if (parsed) {
    const root = terraformRoot(args.cwd, parsed.customer, parsed.environment);
    for (const file of ['main.tf', 'terraform.tfvars']) {
      try {
        const text = await readFile(join(root, file), 'utf8');
        if (/^\s*profile\s*=\s*"prod"/m.test(text)) {
          reasons.push(`${file} in ${root} configures profile = "prod"`);
        }
      } catch {
        // no such root/file: nothing to learn from it
      }
    }
  }
  return { prod: reasons.length > 0, reasons };
}
