import { describe, expect, it } from 'vitest';
import {
  customerSchema,
  ephemeralEnvironmentName,
  isEphemeralEnvironment,
  makeEnvId,
  parseEnvId,
  shortHash,
  slugify,
  validateEnvId,
} from './ids';

describe('env ids', () => {
  it('slugifies branch names safely', () => {
    expect(slugify('Feature/My_Branch!!', 12)).toBe('feature-my-b');
    expect(slugify('///', 12)).toBe('env');
    expect(slugify('a'.repeat(30), 12)).toHaveLength(12);
    expect(slugify('abc-', 12)).toBe('abc');
  });

  it('generates deterministic ephemeral names: same branch, same environment', () => {
    const a = ephemeralEnvironmentName('feature/checkout-v2');
    expect(a).toBe(ephemeralEnvironmentName('feature/checkout-v2'));
    expect(a).toMatch(/^eph-feature-chec-[0-9a-f]{4}$/);
  });

  it('disambiguates branches that slugify identically', () => {
    expect(ephemeralEnvironmentName('feature/A')).not.toBe(ephemeralEnvironmentName('feature-a'));
    expect(shortHash('x')).toHaveLength(4);
  });

  it('builds env-ids that are valid Azure/Terraform identifiers within 40 chars', () => {
    const longest = makeEnvId('abcdefghijkl', ephemeralEnvironmentName('x'.repeat(50)));
    expect(longest.length).toBeLessThanOrEqual(40);
    expect(() => validateEnvId(longest)).not.toThrow();
    expect(makeEnvId('demo', 'dev')).toBe('demo-dev');
  });

  it('rejects invalid customers and env-ids', () => {
    for (const bad of ['Demo', 'de', 'demo-x', '1demo', 'abcdefghijklm']) {
      expect(customerSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(() => validateEnvId('Demo-Dev')).toThrow();
    expect(() => validateEnvId('a-')).toThrow();
    expect(() => validateEnvId(`demo-${'x'.repeat(40)}`)).toThrow();
  });

  it('parses env-ids into customer and environment', () => {
    expect(parseEnvId('demo-eph-my-branch-1a2b')).toEqual({
      envId: 'demo-eph-my-branch-1a2b',
      customer: 'demo',
      environment: 'eph-my-branch-1a2b',
    });
    expect(isEphemeralEnvironment('eph-x-1234')).toBe(true);
    expect(isEphemeralEnvironment('dev')).toBe(false);
  });
});
