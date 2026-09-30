import { safetySwitchesFor, environmentNames } from '@sold/core/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe('next.config security headers', () => {
  it.each(environmentNames)(
    'X-Robots-Tag agrees with safetySwitchesFor(%s).blockIndexing',
    async (environment) => {
      vi.stubEnv('SOLD_ENVIRONMENT', environment);
      vi.resetModules();
      const { securityHeaders } = await import('../../next.config');
      const robots = securityHeaders.find((h) => h.key === 'X-Robots-Tag');
      expect(Boolean(robots)).toBe(safetySwitchesFor(environment).blockIndexing);
    },
  );

  it('always sets the baseline hardening headers', async () => {
    const { securityHeaders } = await import('../../next.config');
    const keys = securityHeaders.map((h) => h.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'Strict-Transport-Security',
        'X-Content-Type-Options',
        'X-Frame-Options',
        'Referrer-Policy',
      ]),
    );
  });
});
