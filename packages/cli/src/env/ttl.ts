import { CliError, ExitCode } from '../lib/errors';

export const DEFAULT_TTL_HOURS = 48;
/** Hard ceiling for the lifetime of an ephemeral environment counted from now (also applies to extensions). */
export const MAX_TTL_HOURS = 168;
export const MIN_TTL_MINUTES = 60;

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** `90m`, `48h`, `2d`. Returns milliseconds. */
export function parseTtl(input: string): number {
  const match = /^(\d+)([mhd])$/.exec(input.trim());
  if (!match) {
    throw new CliError(
      `invalid TTL '${input}': use a number and a unit, e.g. 90m, 48h, 2d`,
      ExitCode.usage,
    );
  }
  const value = Number(match[1]);
  const unit = match[2] as keyof typeof UNIT_MS;
  return value * UNIT_MS[unit];
}

export interface TtlLimits {
  minMs: number;
  maxMs: number;
}

export const DEFAULT_TTL_LIMITS: TtlLimits = {
  minMs: MIN_TTL_MINUTES * UNIT_MS.m,
  maxMs: MAX_TTL_HOURS * UNIT_MS.h,
};

export function validateTtl(ms: number, limits: TtlLimits = DEFAULT_TTL_LIMITS): number {
  if (!Number.isSafeInteger(ms) || ms < limits.minMs) {
    throw new CliError(
      `TTL must be at least ${limits.minMs / UNIT_MS.m} minutes`,
      ExitCode.refused,
    );
  }
  if (ms > limits.maxMs) {
    throw new CliError(
      `TTL exceeds the maximum of ${limits.maxMs / UNIT_MS.h}h for ephemeral environments; ` +
        'long-lived work belongs in dev or stage',
      ExitCode.refused,
    );
  }
  return ms;
}

/** RFC 3339 UTC without milliseconds: what Terraform's `expires_at` and the tag carry. */
export function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function computeExpiresAt(now: Date, ttlMs: number): string {
  return formatTimestamp(new Date(now.getTime() + ttlMs));
}

/** `never` (persistent environments) or an RFC 3339 timestamp. Returns null for `never`. */
export function parseExpiresAt(value: string): Date | null {
  if (value === 'never') return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new CliError(`invalid expires-at value '${value}'`);
  return new Date(time);
}

export function isExpired(expiresAt: string, now: Date): boolean {
  const date = parseExpiresAt(expiresAt);
  return date !== null && date.getTime() <= now.getTime();
}

/**
 * Extending adds `extendMs` to whichever is later, the current expiry or now (an already-expired
 * environment is extended from now), and never lets the result exceed now + maxMs.
 */
export function extendExpiry(
  currentExpiresAt: string,
  now: Date,
  extendMs: number,
  limits: TtlLimits = DEFAULT_TTL_LIMITS,
): string {
  const current = parseExpiresAt(currentExpiresAt);
  if (current === null) {
    throw new CliError(
      'this environment has no expiry (expires-at = never); nothing to extend',
      ExitCode.refused,
    );
  }
  validateTtl(extendMs, { minMs: limits.minMs, maxMs: limits.maxMs });
  const base = Math.max(current.getTime(), now.getTime());
  const next = base + extendMs;
  if (next - now.getTime() > limits.maxMs) {
    throw new CliError(
      `extending by that much would keep the environment alive more than ${limits.maxMs / UNIT_MS.h}h from now; ` +
        'destroy it and recreate, or move the work to dev/stage',
      ExitCode.refused,
    );
  }
  return formatTimestamp(new Date(next));
}

export function formatRemaining(expiresAt: string, now: Date): string {
  const date = parseExpiresAt(expiresAt);
  if (date === null) return 'never';
  const diff = date.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const hours = Math.floor(abs / UNIT_MS.h);
  const minutes = Math.floor((abs % UNIT_MS.h) / UNIT_MS.m);
  const text = hours > 0 ? `${hours}h${String(minutes).padStart(2, '0')}m` : `${minutes}m`;
  return diff >= 0 ? `in ${text}` : `EXPIRED ${text} ago`;
}
