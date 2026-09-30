import { Money } from '@sold/core';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import type { Address } from '../contracts';
import { defaultShippingProvider } from './default-provider';
import { createShippingProvider } from './provider';
import type { ShippingConfigInput } from './schema';
import type { ShippingLineInput, ShippingQuote } from './types';

const NOW = new Date('2026-06-15T00:00:00Z');

const addr = (country: string, region = ''): Address => ({
  line1: '1 Test St',
  city: 'Testville',
  region,
  postalCode: '0000',
  country,
});

interface Opts {
  to: Address;
  currency?: string;
  /** [quantity, unit grams] per line. */
  lines?: [number, number][];
  subtotal?: bigint;
  promo?: boolean;
}

async function quote(provider: typeof defaultShippingProvider, o: Opts): Promise<ShippingQuote[]> {
  const currency = o.currency ?? 'AUD';
  const lines: ShippingLineInput[] = (o.lines ?? [[1, 100]]).map(([quantity, weightGrams], i) => ({
    lineId: `l${i}`,
    quantity,
    weightGrams,
    unitPrice: Money.of(1000n, currency),
  }));
  return provider.quote({
    currency,
    destination: o.to,
    lines,
    subtotal: Money.of(o.subtotal ?? 5000n, currency),
    freeShippingPromo: o.promo ?? false,
    now: NOW,
  });
}

const summary = (qs: ShippingQuote[]): [string, bigint][] =>
  qs.map((q) => [q.methodId, q.amount.amount]);

const method = (id: string) => ({ id, label: id, estimatedDaysMin: 1, estimatedDaysMax: 2 });

describe('zone selection', () => {
  const provider = createShippingProvider({
    zones: [
      // Deliberately listed catch-all first to prove order does not beat specificity.
      {
        id: 'world',
        countries: '*',
        methods: [{ ...method('world'), type: 'flat', prices: { AUD: '30.00' } }],
      },
      {
        id: 'au',
        countries: ['AU'],
        methods: [{ ...method('au'), type: 'flat', prices: { AUD: '10.00' } }],
      },
      {
        id: 'au-wa',
        countries: ['AU'],
        regions: ['wa', 'NT'],
        methods: [{ ...method('au-wa'), type: 'flat', prices: { AUD: '20.00' } }],
      },
      {
        id: 'au-dup',
        countries: ['AU'],
        methods: [{ ...method('au-dup'), type: 'flat', prices: { AUD: '1.00' } }],
      },
      { id: 'blocked', countries: ['KP'], methods: [] },
    ],
  });

  it('region zone beats country zone beats catch-all', async () => {
    expect(summary(await quote(provider, { to: addr('AU', 'WA') }))).toEqual([['au-wa', 2000n]]);
    expect(summary(await quote(provider, { to: addr('AU', 'nt') }))).toEqual([['au-wa', 2000n]]);
    expect(summary(await quote(provider, { to: addr('AU', 'NSW') }))[0]).toEqual(['au', 1000n]);
    expect(summary(await quote(provider, { to: addr('FR') }))).toEqual([['world', 3000n]]);
  });

  it('equal specificity: the earlier zone wins, and there is no fall-through', async () => {
    expect((await quote(provider, { to: addr('AU', 'VIC') })).map((q) => q.methodId)).toEqual([
      'au',
    ]);
  });

  it('a zone with no methods blocks shipping (empty result)', async () => {
    expect(await quote(provider, { to: addr('KP') })).toEqual([]);
  });

  it('no matching zone is an empty result', async () => {
    const auOnly = createShippingProvider({
      zones: [
        {
          id: 'au',
          countries: ['AU'],
          methods: [{ ...method('m'), type: 'flat', prices: { AUD: '1' } }],
        },
      ],
    });
    expect(await quote(auOnly, { to: addr('NZ') })).toEqual([]);
    expect(await quote(createShippingProvider({ zones: [] }), { to: addr('AU') })).toEqual([]);
  });

  it('the winning zone does not fall through when its methods lack the currency', async () => {
    expect(await quote(provider, { to: addr('AU', 'WA'), currency: 'USD' })).toEqual([]);
  });
});

describe('method types', () => {
  const weightTable: ShippingConfigInput = {
    zones: [
      {
        id: 'z',
        countries: '*',
        methods: [
          {
            ...method('w'),
            type: 'weight_table',
            tiers: [
              { maxGrams: 500, prices: { AUD: '5.00' } },
              { maxGrams: 1000, prices: { AUD: '8.00' } },
              { maxGrams: 2000, prices: { AUD: '12.00' } },
            ],
          },
        ],
      },
    ],
  };
  const p = createShippingProvider(weightTable);
  const grams = async (g: number, qty = 1) =>
    summary(await quote(p, { to: addr('AU'), lines: [[qty, g]] }));

  it('weight tier boundaries: upper bound is inclusive', async () => {
    expect(await grams(0)).toEqual([['w', 500n]]);
    expect(await grams(500)).toEqual([['w', 500n]]);
    expect(await grams(501)).toEqual([['w', 800n]]);
    expect(await grams(1000)).toEqual([['w', 800n]]);
    expect(await grams(1001)).toEqual([['w', 1200n]]);
    expect(await grams(2000)).toEqual([['w', 1200n]]);
  });

  it('heavier than the last bounded tier: method unavailable', async () => {
    expect(await grams(2001)).toEqual([]);
  });

  it('total weight is unit weight x quantity summed over lines', async () => {
    expect(await grams(250, 2)).toEqual([['w', 500n]]);
    expect(await grams(250, 3)).toEqual([['w', 800n]]);
    expect(
      summary(
        await quote(p, {
          to: addr('AU'),
          lines: [
            [1, 600],
            [2, 200],
          ],
        }),
      ),
    ).toEqual([['w', 800n]]);
    expect(summary(await quote(p, { to: addr('AU'), lines: [] }))).toEqual([['w', 500n]]);
  });

  it('an unbounded last tier catches everything', async () => {
    const open = createShippingProvider({
      zones: [
        {
          id: 'z',
          countries: '*',
          methods: [
            {
              ...method('w'),
              type: 'weight_table',
              tiers: [
                { maxGrams: 100, prices: { AUD: '1.00' } },
                { maxGrams: null, prices: { AUD: '9.00' } },
              ],
            },
          ],
        },
      ],
    });
    expect(summary(await quote(open, { to: addr('AU'), lines: [[1, 9_000_000]] }))).toEqual([
      ['w', 900n],
    ]);
  });

  it('per_item multiplies by total units', async () => {
    const perItem = createShippingProvider({
      zones: [
        {
          id: 'z',
          countries: '*',
          methods: [{ ...method('pi'), type: 'per_item', prices: { AUD: '2.50' } }],
        },
      ],
    });
    expect(
      summary(
        await quote(perItem, {
          to: addr('AU'),
          lines: [
            [3, 1],
            [2, 1],
          ],
        }),
      ),
    ).toEqual([['pi', 1250n]]);
    expect(summary(await quote(perItem, { to: addr('AU'), lines: [] }))).toEqual([['pi', 0n]]);
  });

  describe('free_over threshold', () => {
    const free = createShippingProvider({
      zones: [
        {
          id: 'z',
          countries: '*',
          methods: [
            {
              ...method('std'),
              type: 'free_over',
              threshold: { AUD: '100.00' },
              belowPrices: { AUD: '9.95' },
            },
            { ...method('only-free'), type: 'free_over', threshold: { AUD: '100.00' } },
          ],
        },
      ],
    });
    it('exact boundary: subtotal == threshold is free; one minor unit below is not', async () => {
      expect(summary(await quote(free, { to: addr('AU'), subtotal: 10_000n }))).toEqual([
        ['only-free', 0n],
        ['std', 0n],
      ]);
      expect(summary(await quote(free, { to: addr('AU'), subtotal: 9_999n }))).toEqual([
        ['std', 995n],
      ]);
      expect(summary(await quote(free, { to: addr('AU'), subtotal: 10_001n }))).toEqual([
        ['only-free', 0n],
        ['std', 0n],
      ]);
    });
    it('without belowPrices the method is not offered below the threshold', async () => {
      expect((await quote(free, { to: addr('AU'), subtotal: 0n })).map((q) => q.methodId)).toEqual([
        'std',
      ]);
    });
  });
});

describe('free shipping promo', () => {
  const provider = createShippingProvider({
    zones: [
      {
        id: 'z',
        countries: '*',
        methods: [
          { ...method('standard'), type: 'flat', prices: { AUD: '9.95' } },
          { ...method('express'), type: 'flat', prices: { AUD: '19.95' }, promoEligible: false },
          { ...method('usd-only'), type: 'flat', prices: { USD: '5.00' } },
        ],
      },
    ],
  });

  it('zeroes eligible methods only, keeps ineligible ones, and never revives unavailable ones', async () => {
    expect(summary(await quote(provider, { to: addr('AU'), promo: true }))).toEqual([
      ['standard', 0n],
      ['express', 1995n],
    ]);
    expect(summary(await quote(provider, { to: addr('AU'), promo: false }))).toEqual([
      ['standard', 995n],
      ['express', 1995n],
    ]);
  });

  it('a promo with nothing available is still empty', async () => {
    expect(await quote(provider, { to: addr('AU'), promo: true, currency: 'GBP' })).toEqual([]);
  });
});

describe('currency handling', () => {
  const provider = createShippingProvider({
    zones: [
      {
        id: 'z',
        countries: '*',
        methods: [
          {
            ...method('flat'),
            type: 'flat',
            prices: { AUD: '10.00', USD: '7.00', JPY: '900', KWD: '2.500' },
          },
          { ...method('aud-only'), type: 'flat', prices: { AUD: '5.00' } },
          {
            ...method('tiered'),
            type: 'weight_table',
            tiers: [{ maxGrams: 1000, prices: { AUD: '6.00', USD: '4.00' } }],
          },
        ],
      },
    ],
  });

  it('multi-currency: each method is priced only in currencies it declares, never converted', async () => {
    expect(summary(await quote(provider, { to: addr('AU'), currency: 'AUD' }))).toEqual([
      ['aud-only', 500n],
      ['tiered', 600n],
      ['flat', 1000n],
    ]);
    expect(summary(await quote(provider, { to: addr('AU'), currency: 'USD' }))).toEqual([
      ['tiered', 400n],
      ['flat', 700n],
    ]);
    expect(await quote(provider, { to: addr('AU'), currency: 'EUR' })).toEqual([]);
  });

  it('JPY (0 decimals) and KWD (3 decimals) are exact minor units', async () => {
    const jpy = await quote(provider, { to: addr('AU'), currency: 'JPY' });
    expect(summary(jpy)).toEqual([['flat', 900n]]);
    expect(jpy[0]?.amount.toString()).toBe('900 JPY');
    const kwd = await quote(provider, { to: addr('AU'), currency: 'KWD' });
    expect(summary(kwd)).toEqual([['flat', 2500n]]);
    expect(kwd[0]?.amount.toString()).toBe('2.500 KWD');
  });

  it('rejects an order whose subtotal or line prices are in another currency', () => {
    expect(() =>
      provider.quote({
        currency: 'AUD',
        destination: addr('AU'),
        lines: [],
        subtotal: Money.of(1n, 'USD'),
        freeShippingPromo: false,
        now: NOW,
      }),
    ).toThrow(/Currency mismatch/);
    expect(() =>
      provider.quote({
        currency: 'AUD',
        destination: addr('AU'),
        lines: [{ lineId: 'a', quantity: 1, weightGrams: 1, unitPrice: Money.of(1n, 'USD') }],
        subtotal: Money.of(1n, 'AUD'),
        freeShippingPromo: false,
        now: NOW,
      }),
    ).toThrow(/Currency mismatch/);
  });

  it('rejects invalid quantities and weights', () => {
    const bad = (quantity: number, weightGrams: number) => () =>
      provider.quote({
        currency: 'AUD',
        destination: addr('AU'),
        lines: [{ lineId: 'a', quantity, weightGrams, unitPrice: Money.of(1n, 'AUD') }],
        subtotal: Money.of(1n, 'AUD'),
        freeShippingPromo: false,
        now: NOW,
      });
    expect(bad(-1, 1)).toThrow(RangeError);
    expect(bad(1, 1.5)).toThrow(RangeError);
    expect(bad(1, Number.NaN)).toThrow(RangeError);
  });
});

describe('ordering and metadata', () => {
  it('orders by price then id, and passes carrier and estimates through', async () => {
    const provider = createShippingProvider({
      zones: [
        {
          id: 'z',
          countries: '*',
          methods: [
            { ...method('b'), type: 'flat', prices: { AUD: '5.00' } },
            { ...method('c'), type: 'flat', prices: { AUD: '1.00' } },
            { ...method('a'), type: 'flat', prices: { AUD: '5.00' }, carrier: 'AusPost' },
            { ...method('Z'), type: 'flat', prices: { AUD: '5.00' } },
          ],
        },
      ],
    });
    const qs = await quote(provider, { to: addr('AU') });
    expect(qs.map((q) => q.methodId)).toEqual(['c', 'Z', 'a', 'b']); // code-point order: 'Z' < 'a'
    expect(qs.find((q) => q.methodId === 'a')).toMatchObject({
      label: 'a',
      carrier: 'AusPost',
      estimatedDaysMin: 1,
      estimatedDaysMax: 2,
    });
    expect('carrier' in (qs.find((q) => q.methodId === 'b') ?? {})).toBe(false);
  });

  it('is deterministic regardless of config order', async () => {
    const methods = [
      { ...method('x'), type: 'flat' as const, prices: { AUD: '3.00' } },
      { ...method('y'), type: 'flat' as const, prices: { AUD: '3.00' } },
      { ...method('w'), type: 'flat' as const, prices: { AUD: '2.00' } },
    ];
    const a = createShippingProvider({ zones: [{ id: 'z', countries: '*', methods }] });
    const b = createShippingProvider({
      zones: [{ id: 'z', countries: '*', methods: [...methods].reverse() }],
    });
    expect(summary(await quote(a, { to: addr('AU') }))).toEqual(
      summary(await quote(b, { to: addr('AU') })),
    );
  });
});

describe('default (example) provider', () => {
  it('AU: free standard at the A$150.00 boundary, remote regions priced separately', async () => {
    expect(
      summary(await quote(defaultShippingProvider, { to: addr('AU', 'NSW'), subtotal: 14_999n })),
    ).toEqual([
      ['standard', 995n],
      ['express', 1595n],
    ]);
    expect(
      summary(await quote(defaultShippingProvider, { to: addr('AU', 'NSW'), subtotal: 15_000n })),
    ).toEqual([
      ['standard', 0n],
      ['express', 1595n],
    ]);
    expect(summary(await quote(defaultShippingProvider, { to: addr('AU', 'TAS') }))).toEqual([
      ['standard', 1995n],
    ]);
  });

  it('international JPY order uses the JPY prices; an unpriced currency cannot ship', async () => {
    expect(
      summary(await quote(defaultShippingProvider, { to: addr('JP'), currency: 'JPY' })),
    ).toEqual([['intl-standard', 2400n]]);
    expect(await quote(defaultShippingProvider, { to: addr('JP'), currency: 'KWD' })).toEqual([]);
  });
});

describe('config validation', () => {
  const ok = {
    id: 'm',
    label: 'M',
    estimatedDaysMin: 1,
    estimatedDaysMax: 2,
    type: 'flat',
    prices: { AUD: '1.00' },
  };
  const zone = { id: 'z', countries: '*', methods: [ok] };

  it('accepts a valid config', () => {
    expect(() => createShippingProvider({ zones: [zone] } as ShippingConfigInput)).not.toThrow();
  });

  it('rejects malformed configs with a ZodError', () => {
    const bad: unknown[] = [
      { zones: [{ ...zone, methods: [{ ...ok, prices: { AUD: '1.005' } }] }] }, // too many decimals
      { zones: [{ ...zone, methods: [{ ...ok, prices: { JPY: '10.5' } }] }] },
      { zones: [{ ...zone, methods: [{ ...ok, prices: { AUD: '-1.00' } }] }] },
      { zones: [{ ...zone, methods: [{ ...ok, prices: { AUD: 'free' } }] }] },
      { zones: [{ ...zone, methods: [{ ...ok, prices: { aud: '1.00' } }] }] },
      { zones: [{ ...zone, methods: [{ ...ok, prices: {} }] }] },
      { zones: [{ ...zone, methods: [{ ...ok, prices: { ZZZ: '1.00' } }] }] }, // unknown currency
      { zones: [{ ...zone, methods: [{ ...ok, estimatedDaysMin: 5, estimatedDaysMax: 2 }] }] },
      { zones: [{ ...zone, methods: [{ ...ok, type: 'teleport' }] }] },
      { zones: [{ ...zone, methods: [ok, ok] }] }, // duplicate method id
      { zones: [zone, zone] }, // duplicate zone id
      { zones: [{ ...zone, regions: ['WA'] }] }, // regions with '*'
      { zones: [{ ...zone, countries: ['australia'] }] },
      { zones: [{ ...zone, countries: [] }] },
      { zones: [{ ...zone, extra: true }] },
      {
        zones: [
          {
            ...zone,
            methods: [
              {
                ...ok,
                type: 'weight_table',
                prices: undefined,
                tiers: [
                  { maxGrams: 500, prices: { AUD: '1.00' } },
                  { maxGrams: 500, prices: { AUD: '2.00' } },
                ],
              },
            ],
          },
        ],
      },
      {
        zones: [
          {
            ...zone,
            methods: [
              {
                ...ok,
                type: 'weight_table',
                prices: undefined,
                tiers: [
                  { maxGrams: null, prices: { AUD: '1.00' } },
                  { maxGrams: 500, prices: { AUD: '2.00' } },
                ],
              },
            ],
          },
        ],
      },
      {
        zones: [
          {
            ...zone,
            methods: [
              {
                ...ok,
                type: 'weight_table',
                prices: undefined,
                tiers: [
                  { maxGrams: 100, prices: { AUD: '1.00' } },
                  { maxGrams: 500, prices: { USD: '2.00' } },
                ],
              },
            ],
          },
        ],
      },
    ];
    for (const config of bad) {
      expect(() => createShippingProvider(config as ShippingConfigInput)).toThrow(ZodError);
    }
  });
});
