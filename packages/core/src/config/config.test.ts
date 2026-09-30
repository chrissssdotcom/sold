import { describe, expect, it } from 'vitest';
import { defineConfig, normalizeExtensions, safetySwitchesFor, soldConfigSchema } from './index';

const valid = {
  instance: { name: 'Acme', customer: 'acme' },
  currencies: {
    base: 'AUD',
    enabled: [{ code: 'AUD' }, { code: 'JPY', strategy: 'fixed' as const }],
  },
  locales: { default: 'en-AU', enabled: ['en-AU'] },
};

describe('soldConfigSchema', () => {
  it('applies defaults', () => {
    const cfg = defineConfig(valid);
    expect(cfg.tier).toBe('standard');
    expect(cfg.gateways.enabled).toEqual(['manual']);
    expect(cfg.scale.mode).toBe('normal');
    expect(cfg.currencies.enabled[0]?.strategy).toBe('derived');
  });

  it('rejects a base currency that is not enabled', () => {
    const r = soldConfigSchema.safeParse({
      ...valid,
      currencies: { base: 'USD', enabled: [{ code: 'AUD' }] },
    });
    expect(r.success).toBe(false);
  });

  it('rejects duplicate currencies and bad codes', () => {
    expect(
      soldConfigSchema.safeParse({
        ...valid,
        currencies: { base: 'AUD', enabled: [{ code: 'AUD' }, { code: 'AUD' }] },
      }).success,
    ).toBe(false);
    expect(
      soldConfigSchema.safeParse({
        ...valid,
        currencies: { base: 'aud', enabled: [{ code: 'aud' }] },
      }).success,
    ).toBe(false);
  });

  it('rejects a default locale that is not enabled', () => {
    expect(
      soldConfigSchema.safeParse({ ...valid, locales: { default: 'fr', enabled: ['en-AU'] } })
        .success,
    ).toBe(false);
  });

  it('rejects unknown keys (strict) and a tenant_id', () => {
    expect(soldConfigSchema.safeParse({ ...valid, tenant_id: 'x' }).success).toBe(false);
  });

  it('normalises extension entries', () => {
    const cfg = defineConfig({
      ...valid,
      extensions: ['reviews', { name: 'loyalty', enabled: false }],
    });
    expect(normalizeExtensions(cfg)).toEqual([
      { name: 'reviews', enabled: true, settings: {} },
      { name: 'loyalty', enabled: false, settings: {} },
    ]);
  });
});

describe('safetySwitchesFor', () => {
  it.each(['local', 'ephemeral', 'dev', 'stage'] as const)('%s is locked down', (env) => {
    const s = safetySwitchesFor(env);
    expect(s).toMatchObject({
      stripeTestModeOnly: true,
      emailTransport: 'capture',
      outboundSinks: true,
      blockIndexing: true,
      allowRealPii: false,
    });
  });

  it('prod is live', () => {
    expect(safetySwitchesFor('prod')).toMatchObject({
      stripeTestModeOnly: false,
      emailTransport: 'production',
      blockIndexing: false,
    });
  });
});
