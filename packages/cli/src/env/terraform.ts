import { join } from 'node:path';
import type { TierName } from '@sold/core/config';
import type { Step } from '../lib/steps';
import {
  PROFILE_INFO,
  profilesDir,
  terraformRoot,
  tierTfvars,
  type DeployProfile,
} from './profiles';
import { isEphemeralEnvironment, type ParsedEnvId } from './ids';

/** Values the ephemeral root needs. Stored in state as the `inputs` output so any later command can re-apply. */
export interface EphemeralInputs {
  env_id: string;
  environment: string;
  owner: string;
  expires_at: string;
  release_version: string;
  image: string;
  worker_image?: string | null;
  migrate_image?: string | null;
  /** Edge settings, so pause/resume/extend re-apply the same Cloudflare resources instead of removing them. */
  cloudflare?: {
    enabled: boolean;
    account_id?: string;
    zone_id?: string;
    hostname?: string;
  } | null;
}

export const STATE_KEY_PREFIX = 'ephemeral';

export function stateKeyFor(envId: string): string {
  return `${STATE_KEY_PREFIX}/${envId}.tfstate`;
}

export interface TerraformTarget {
  cwd: string;
  parsed: ParsedEnvId;
  profile: DeployProfile;
  tier: TierName;
  /** `terraform` or `tofu`. */
  binary: string;
}

export function rootFor(target: TerraformTarget): string {
  return terraformRoot(target.cwd, target.parsed.customer, target.parsed.environment);
}

export function initStep(target: TerraformTarget): Step {
  const args = ['init', '-input=false', '-no-color'];
  if (isEphemeralEnvironment(target.parsed.environment)) {
    // One shared root, one state per environment (customer's own storage account, Entra auth).
    args.push('-reconfigure', `-backend-config=key=${stateKeyFor(target.parsed.envId)}`);
  }
  return {
    description: `initialise Terraform for ${target.parsed.envId}`,
    command: target.binary,
    args: [`-chdir=${rootFor(target)}`, ...args],
    stream: true,
  };
}

export function varFiles(target: TerraformTarget): string[] {
  const info = PROFILE_INFO[target.profile];
  const files = [`-var-file=${join(profilesDir(target.cwd), info.tfvars)}`];
  if (info.usesTier) {
    files.push(`-var-file=${join(profilesDir(target.cwd), tierTfvars(target.tier))}`);
    // The composite records the tier; it must match the capacity file so the two can never disagree.
    files.push(`-var=tier=${target.tier}`);
  }
  return files;
}

export function ephemeralVarArgs(inputs: EphemeralInputs): string[] {
  const args = [
    `-var=env_id=${inputs.env_id}`,
    `-var=environment=${inputs.environment}`,
    `-var=owner=${inputs.owner}`,
    `-var=expires_at=${inputs.expires_at}`,
    `-var=release_version=${inputs.release_version}`,
    `-var=image=${inputs.image}`,
  ];
  if (inputs.worker_image) args.push(`-var=worker_image=${inputs.worker_image}`);
  if (inputs.migrate_image) args.push(`-var=migrate_image=${inputs.migrate_image}`);
  // HCL accepts a JSON-style object literal for an object-typed variable.
  if (inputs.cloudflare) args.push(`-var=cloudflare=${JSON.stringify(inputs.cloudflare)}`);
  return args;
}

export function applyStep(target: TerraformTarget, extra: string[], description: string): Step {
  return {
    description,
    command: target.binary,
    args: [
      `-chdir=${rootFor(target)}`,
      'apply',
      '-input=false',
      '-auto-approve',
      '-no-color',
      ...varFiles(target),
      ...extra,
    ],
    stream: true,
  };
}

export const PLAN_FILE = 'tfplan';

export function planStep(target: TerraformTarget, noLock: boolean): Step {
  return {
    description: `plan ${target.parsed.envId} (read-only)`,
    command: target.binary,
    args: [
      `-chdir=${rootFor(target)}`,
      'plan',
      '-input=false',
      '-no-color',
      '-detailed-exitcode',
      `-out=${PLAN_FILE}`,
      ...(noLock ? ['-lock=false'] : []),
      ...varFiles(target),
    ],
    stream: true,
  };
}

export function showPlanStep(target: TerraformTarget): Step {
  return {
    description: 'render the plan as JSON',
    command: target.binary,
    args: [`-chdir=${rootFor(target)}`, 'show', '-json', '-no-color', PLAN_FILE],
    readOnly: true,
  };
}

export function destroyStep(target: TerraformTarget, extra: string[]): Step {
  return {
    description: `destroy every Terraform-managed resource of ${target.parsed.envId}`,
    command: target.binary,
    args: [
      `-chdir=${rootFor(target)}`,
      'destroy',
      '-input=false',
      '-auto-approve',
      '-no-color',
      ...varFiles(target),
      ...extra,
    ],
    stream: true,
  };
}

export function outputStep(target: TerraformTarget, name: string, json: boolean): Step {
  return {
    description: `read Terraform output '${name}'`,
    command: target.binary,
    args: [`-chdir=${rootFor(target)}`, 'output', json ? '-json' : '-raw', name],
    readOnly: true,
    allowFailure: true,
  };
}

/** Parses `terraform output -json inputs`. Returns undefined when the state has no such output. */
export function parseInputsOutput(stdout: string): EphemeralInputs | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    for (const key of [
      'env_id',
      'environment',
      'owner',
      'expires_at',
      'release_version',
      'image',
    ]) {
      if (typeof record[key] !== 'string') return undefined;
    }
    return record as unknown as EphemeralInputs;
  } catch {
    return undefined;
  }
}
