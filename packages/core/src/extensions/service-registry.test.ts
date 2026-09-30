import { describe, expect, it } from 'vitest';
import { ServiceRegistry, ServiceResolutionError } from './service-registry';

const rounding = (suffix: string, key = suffix) => ({
  service: 'pricing.rounding' as const,
  key,
  create: () => ({ round: (minor: bigint) => minor + BigInt(suffix.length) }),
});

describe('ServiceRegistry', () => {
  it('uses the Base default when nothing overrides it', async () => {
    const r = new ServiceRegistry();
    r.register(rounding('base'), 'base', 'base');
    r.resolve();
    expect(r.activeProvider('pricing.rounding')).toMatchObject({ owner: 'base', origin: 'base' });
    expect((await r.get('pricing.rounding')).round(100n, 'AUD')).toBe(104n);
  });

  it('precedence: instance extension > first-party extension > Base default', () => {
    const r = new ServiceRegistry();
    r.register(rounding('base'), 'base', 'base');
    r.register(rounding('fp', 'charm'), 'first-party', 'pricing-pack');
    r.resolve();
    expect(r.activeProvider('pricing.rounding')).toMatchObject({ owner: 'pricing-pack' });
    r.register(rounding('acme', 'acme-rounding'), 'instance', 'acme-custom');
    r.resolve();
    expect(r.activeProvider('pricing.rounding')).toMatchObject({
      owner: 'acme-custom',
      origin: 'instance',
    });
  });

  it('config selection beats precedence', () => {
    const r = new ServiceRegistry();
    r.register(rounding('base', 'default'), 'base', 'base');
    r.register(rounding('acme', 'acme-rounding'), 'instance', 'acme-custom');
    r.resolve({ 'pricing.rounding': 'default' });
    expect(r.activeProvider('pricing.rounding')).toMatchObject({ key: 'default', origin: 'base' });
  });

  it('refuses to guess when two providers tie, and says how to fix it', () => {
    const r = new ServiceRegistry();
    r.register(rounding('a', 'charm'), 'instance', 'ext-one');
    r.register(rounding('b', 'psychological'), 'instance', 'ext-two');
    expect(() => r.resolve()).toThrow(
      /tie at precedence "instance".*select one in sold\.config\.ts/,
    );
    r.resolve({ 'pricing.rounding': 'psychological' });
    expect(r.activeProvider('pricing.rounding')?.owner).toBe('ext-two');
  });

  it('rejects selections of unknown providers or services, listing what is available', () => {
    const r = new ServiceRegistry();
    r.register(rounding('base', 'default'), 'base', 'base');
    expect(() => r.resolve({ 'pricing.rounding': 'nope' })).toThrow(
      /not registered \(available: default\)/,
    );
    expect(() => r.resolve({ 'tax.calculator': 'x' })).toThrow(ServiceResolutionError);
  });

  it('caches the instance, and a failing factory does not poison later calls', async () => {
    const r = new ServiceRegistry();
    let calls = 0;
    r.register(
      {
        service: 'pricing.rounding',
        key: 'flaky',
        create: () => {
          if (++calls === 1) throw new Error('cold start');
          return { round: (m: bigint) => m };
        },
      },
      'base',
      'base',
    );
    r.resolve();
    await expect(r.get('pricing.rounding')).rejects.toThrow('cold start');
    const svc = await r.get('pricing.rounding');
    expect(await r.get('pricing.rounding')).toBe(svc);
    expect(calls).toBe(2);
  });

  it('fails clearly when a service has no provider', async () => {
    const r = new ServiceRegistry();
    r.resolve();
    await expect(r.get('pricing.rounding')).rejects.toThrow(/No provider/);
  });
});
