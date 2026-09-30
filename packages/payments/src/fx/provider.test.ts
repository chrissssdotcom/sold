import { describe, expect, it } from 'vitest';
import { HttpFxProvider, StaticFxProvider, rationalFromJson } from './provider';

describe('rationalFromJson', () => {
  it('is exact for decimals, including numbers that are inexact in binary', () => {
    expect(rationalFromJson(0.1)).toEqual({ numerator: 1n, denominator: 10n });
    expect(rationalFromJson(0.6543)).toEqual({ numerator: 6543n, denominator: 10_000n });
    expect(rationalFromJson('96.5')).toEqual({ numerator: 965n, denominator: 10n });
    expect(rationalFromJson(1)).toEqual({ numerator: 1n, denominator: 1n });
  });

  it('handles exponent notation', () => {
    expect(rationalFromJson(1e-7)).toEqual({ numerator: 1n, denominator: 10_000_000n });
    expect(rationalFromJson(1.5e-7)).toEqual({ numerator: 15n, denominator: 100_000_000n });
    expect(rationalFromJson(1e21)).toEqual({ numerator: 10n ** 21n, denominator: 1n });
    expect(rationalFromJson(2.5e3)).toEqual({ numerator: 2500n, denominator: 1n });
  });

  it('rejects junk, zero, negatives and non-finite values', () => {
    for (const bad of [0, -1, NaN, Infinity, 'abc', null, {}, '1,5'])
      expect(() => rationalFromJson(bad)).toThrow();
  });
});

describe('providers', () => {
  it('static provider returns only rates it knows', async () => {
    const p = new StaticFxProvider({ AUDUSD: '0.65' });
    expect(await p.fetchRates('AUD', ['USD', 'JPY'])).toEqual([
      { base: 'AUD', quote: 'USD', rate: { numerator: 65n, denominator: 100n } },
    ]);
  });

  it('http provider parses a rates feed and surfaces failures', async () => {
    const ok = (body: unknown, status = 200) =>
      (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const url = (b: string, q: readonly string[]) =>
      `https://feed.test/latest?from=${b}&to=${q.join(',')}`;
    const good = new HttpFxProvider({ url, fetch: ok({ rates: { USD: 0.6543, JPY: 96.5 } }) });
    expect(await good.fetchRates('AUD', ['USD', 'JPY', 'NZD'])).toHaveLength(2);
    await expect(
      new HttpFxProvider({ url, fetch: ok({}, 500) }).fetchRates('AUD', ['USD']),
    ).rejects.toThrow(/500/);
    await expect(
      new HttpFxProvider({ url, fetch: ok({ nope: 1 }) }).fetchRates('AUD', ['USD']),
    ).rejects.toThrow(/rates/);
    await expect(
      new HttpFxProvider({ url, fetch: ok({ rates: { USD: -1 } }) }).fetchRates('AUD', ['USD']),
    ).rejects.toThrow();
  });
});
