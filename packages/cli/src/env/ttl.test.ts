import { describe, expect, it } from 'vitest';
import { CliError, ExitCode } from '../lib/errors';
import {
  DEFAULT_TTL_HOURS,
  MAX_TTL_HOURS,
  computeExpiresAt,
  extendExpiry,
  formatRemaining,
  isExpired,
  parseExpiresAt,
  parseTtl,
  validateTtl,
} from './ttl';

const now = new Date('2026-09-30T12:00:00Z');

describe('ttl', () => {
  it('parses durations', () => {
    expect(parseTtl('90m')).toBe(90 * 60_000);
    expect(parseTtl('48h')).toBe(48 * 3_600_000);
    expect(parseTtl('2d')).toBe(2 * 86_400_000);
  });

  it.each(['', '48', 'h', '1.5h', '-1h', '2w', '48H', '1 h'])('rejects %j', (bad) => {
    expect(() => parseTtl(bad)).toThrow(CliError);
  });

  it('has a 48h default and a 7 day maximum', () => {
    expect(DEFAULT_TTL_HOURS).toBe(48);
    expect(MAX_TTL_HOURS).toBe(168);
    expect(validateTtl(parseTtl('168h'))).toBe(168 * 3_600_000);
    expect(() => validateTtl(parseTtl('169h'))).toThrow(/maximum of 168h/);
    expect(() => validateTtl(parseTtl('30m'))).toThrow(/at least 60 minutes/);
    try {
      validateTtl(parseTtl('9d'));
    } catch (error) {
      expect((error as CliError).exitCode).toBe(ExitCode.refused);
    }
  });

  it('stamps expiry as RFC 3339 UTC without milliseconds', () => {
    expect(computeExpiresAt(now, parseTtl('48h'))).toBe('2026-10-02T12:00:00Z');
    expect(computeExpiresAt(new Date('2026-09-30T12:00:00.789Z'), parseTtl('1h'))).toBe(
      '2026-09-30T13:00:00Z',
    );
  });

  it('detects expiry; never does not expire', () => {
    expect(isExpired('2026-09-30T11:59:59Z', now)).toBe(true);
    expect(isExpired('2026-09-30T12:00:00Z', now)).toBe(true);
    expect(isExpired('2026-09-30T12:00:01Z', now)).toBe(false);
    expect(isExpired('never', now)).toBe(false);
    expect(parseExpiresAt('never')).toBeNull();
    expect(() => parseExpiresAt('tomorrow')).toThrow(CliError);
  });

  it('extends from the current expiry, or from now when already expired', () => {
    expect(extendExpiry('2026-10-01T12:00:00Z', now, parseTtl('24h'))).toBe('2026-10-02T12:00:00Z');
    expect(extendExpiry('2026-09-29T00:00:00Z', now, parseTtl('24h'))).toBe('2026-10-01T12:00:00Z');
  });

  it('never lets an environment live more than 7 days from now', () => {
    expect(() => extendExpiry('2026-10-07T00:00:00Z', now, parseTtl('24h'))).toThrow(
      /more than 168h/,
    );
    expect(extendExpiry('2026-10-07T00:00:00Z', now, parseTtl('1h'))).toBe('2026-10-07T01:00:00Z');
    expect(() => extendExpiry('never', now, parseTtl('1h'))).toThrow(/nothing to extend/);
  });

  it('formats time remaining', () => {
    expect(formatRemaining('2026-10-01T13:30:00Z', now)).toBe('in 25h30m');
    expect(formatRemaining('2026-09-30T12:20:00Z', now)).toBe('in 20m');
    expect(formatRemaining('2026-09-30T09:00:00Z', now)).toBe('EXPIRED 3h00m ago');
    expect(formatRemaining('never', now)).toBe('never');
  });
});
