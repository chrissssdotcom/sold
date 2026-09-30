import { createHash } from 'node:crypto';
import { z } from 'zod';

/** 3-12 lowercase alphanumerics, no hyphen: env-ids parse unambiguously (`<customer>-<environment>`). */
export const customerSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9]{2,11}$/,
    'customer must be 3-12 lowercase alphanumerics starting with a letter',
  );

/** Persistent environments are named after their rung; ephemeral ones start with `eph-`. */
export const persistentEnvironmentNames = ['dev', 'stage', 'prod'] as const;
export type PersistentEnvironmentName = (typeof persistentEnvironmentNames)[number];

export const ENV_ID_MAX_LENGTH = 40;
const ENV_ID_PATTERN = /^[a-z][a-z0-9-]{2,38}[a-z0-9]$/;

export function slugify(input: string, maxLength: number): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug === '' ? 'env' : slug;
}

/** Short stable hash of the raw input: same branch => same environment (idempotent `env:up`). */
export function shortHash(input: string, length = 4): string {
  return createHash('sha256').update(input).digest('hex').slice(0, length);
}

/**
 * Deterministic ephemeral environment name from a branch or preview label:
 * `eph-<slug>-<hash>`. The hash disambiguates branches that slugify identically
 * (`feature/A` vs `feature-a`).
 */
export function ephemeralEnvironmentName(label: string): string {
  return `eph-${slugify(label, 12)}-${shortHash(label)}`;
}

export function makeEnvId(customer: string, environment: string): string {
  customerSchema.parse(customer);
  const envId = `${customer}-${environment}`;
  return validateEnvId(envId);
}

export function validateEnvId(envId: string): string {
  if (envId.length > ENV_ID_MAX_LENGTH || !ENV_ID_PATTERN.test(envId)) {
    throw new Error(
      `invalid env-id '${envId}': 4-${ENV_ID_MAX_LENGTH} chars of lowercase alphanumerics and hyphens`,
    );
  }
  return envId;
}

export interface ParsedEnvId {
  envId: string;
  customer: string;
  environment: string;
}

export function parseEnvId(envId: string): ParsedEnvId {
  validateEnvId(envId);
  const dash = envId.indexOf('-');
  if (dash < 1) throw new Error(`invalid env-id '${envId}': expected <customer>-<environment>`);
  const customer = envId.slice(0, dash);
  customerSchema.parse(customer);
  return { envId, customer, environment: envId.slice(dash + 1) };
}

export function isEphemeralEnvironment(environment: string): boolean {
  return environment.startsWith('eph-');
}
