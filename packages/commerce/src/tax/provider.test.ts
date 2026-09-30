import { Money } from '@sold/core';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import type { Address } from '../contracts';
import { defaultTaxProvider } from './default-provider';
import { createTaxProvider } from './provider';
import type { TaxRuleInput } from './schema';
import type { TaxInput, TaxLineInput, TaxResult } from './types';

const NOW = new Date('2026-06-15T00:00:00Z');

const addr = (country: string, region = ''): Address => ({
  line1: '1 Test St',
  city: 'Testville',
  region,
  postalCode: '0000',
  country,
});

interface Opts {
  currency?: string;
  lines: { id?: string; amount: bigint; category?: string }[];
  shipping?: bigint;
  to: Address;
  from?: Address;
  inclusive: boolean;
  exempt?: boolean;
  now?: Date;
}

function input(o: Opts): TaxInput {
  const currency = o.currency ?? 'AUD';
  const lines: TaxLineInput[] = o.lines.map((l, i) => ({
    lineId: l.id ?? `l${i + 1}`,
    net: Money.of(l.amount, currency),
    taxCategory: l.category ?? 'standard',
    quantity: 1,
  }));
  return {
    currency,
    lines,
    shipping: Money.of(o.shipping ?? 0n, currency),
    destination: o.to,
    origin: o.from ?? addr('AU', 'NSW'),
    pricesIncludeTax: o.inclusive,
    customerTaxExempt: o.exempt,
    now: o.now ?? NOW,
  };
}

async function run(o: Opts): Promise<TaxResult> {
  return defaultTaxProvider.calculate(input(o));
}

const taxes = (r: TaxResult): bigint[] => r.lines.map((l) => l.tax.amount);

describe('AU GST', () => {
  it('exclusive: adds 10% on top', async () => {
    const r = await run({ lines: [{ amount: 1000n }], to: addr('AU', 'NSW'), inclusive: false });
    expect(taxes(r)).toEqual([100n]);
    expect(r.total.amount).toBe(100n);
    expect(r.pricesIncludeTax).toBe(false);
    expect(r.lines[0]?.rates).toEqual([{ name: 'GST', rate: 1000, amount: Money.of(100n, 'AUD') }]);
  });

  it('exclusive: rounds half-up per line (0.5 rounds up, 0.4 down)', async () => {
    const r = await run({
      lines: [{ amount: 5n }, { amount: 4n }, { amount: 1099n }],
      to: addr('AU'),
      inclusive: false,
    });
    expect(taxes(r)).toEqual([1n, 0n, 110n]); // 0.5 -> 1, 0.4 -> 0, 109.9 -> 110
    expect(r.total.amount).toBe(111n);
  });

  it('inclusive: extracts gross * R / (10000 + R), rounded half-up once', async () => {
    const r = await run({
      lines: [{ amount: 1100n }, { amount: 999n }, { amount: 21n }, { amount: 11n }],
      to: addr('AU'),
      inclusive: true,
    });
    // 1100 -> 100 exactly; 999 -> 90.818 -> 91; 21 -> 1.909 -> 2; 11 -> 1 exactly
    expect(taxes(r)).toEqual([100n, 91n, 2n, 1n]);
    expect(r.total.amount).toBe(194n);
    expect(r.pricesIncludeTax).toBe(true);
  });

  it('inclusive: the exact .5 case rounds up', async () => {
    // A 50% rate makes exact halves easy to build.
    const provider = createTaxProvider({
      rules: [
        {
          country: 'XX',
          category: 'standard',
          name: 'Half',
          rateBps: 5000,
          appliesToShipping: true,
        },
      ],
    });
    // gross 3 @ 50%: 3 * 5000 / 15000 = 1.0 ; gross 9: 3.0 ; gross 1: 0.333 ; gross 2: 0.667 -> 1
    const r = await provider.calculate(
      input({
        lines: [{ amount: 3n }, { amount: 1n }, { amount: 2n }],
        to: addr('XX'),
        inclusive: true,
      }),
    );
    expect(taxes(r)).toEqual([1n, 0n, 1n]);
    // exclusive: 1 @ 50% = 0.5 -> 1, 3 @ 50% = 1.5 -> 2
    const e = await provider.calculate(
      input({ lines: [{ amount: 1n }, { amount: 3n }], to: addr('XX'), inclusive: false }),
    );
    expect(taxes(e)).toEqual([1n, 2n]); // 0.5 -> 1, 1.5 -> 2
  });

  it('GST-free (`exempt`) category is 0% via an explicit rule and appears in the breakdown', async () => {
    const r = await run({
      lines: [{ amount: 1000n, category: 'exempt' }, { amount: 1000n }],
      to: addr('AU'),
      inclusive: false,
    });
    expect(taxes(r)).toEqual([0n, 100n]);
    expect(r.breakdown.map((b) => [b.name, b.rateBps, b.taxable.amount, b.amount.amount])).toEqual([
      ['GST', 1000, 1000n, 100n],
      ['GST-free', 0, 1000n, 0n],
    ]);
  });
});

describe('shipping', () => {
  it('is taxed when the standard rule applies to shipping (exclusive and inclusive)', async () => {
    const ex = await run({
      lines: [{ amount: 1000n }],
      shipping: 500n,
      to: addr('AU'),
      inclusive: false,
    });
    expect(ex.shipping.tax.amount).toBe(50n);
    expect(ex.shipping.rates).toEqual([{ name: 'GST', rate: 1000, amount: Money.of(50n, 'AUD') }]);
    expect(ex.total.amount).toBe(150n);

    const inc = await run({
      lines: [{ amount: 1100n }],
      shipping: 550n,
      to: addr('AU'),
      inclusive: true,
    });
    expect(inc.shipping.tax.amount).toBe(50n);
    expect(inc.total.amount).toBe(150n);
  });

  it('is untaxed when appliesToShipping is false', async () => {
    const r = await run({
      lines: [{ amount: 1999n }],
      shipping: 1000n,
      to: addr('US', 'NY'),
      from: addr('US', 'NY'),
      inclusive: false,
    });
    expect(r.shipping.tax.amount).toBe(0n);
    expect(r.shipping.rates).toEqual([]);
    expect(r.total.amount).toBe(170n);
  });

  it('uses only the standard rules, so GB reduced goods do not make shipping 5%', async () => {
    const r = await run({
      lines: [{ amount: 1000n, category: 'reduced' }],
      shipping: 1000n,
      to: addr('GB'),
      inclusive: false,
      currency: 'GBP',
    });
    expect(taxes(r)).toEqual([50n]);
    expect(r.shipping.tax.amount).toBe(200n);
    expect(r.total.amount).toBe(250n);
  });
});

describe('GB VAT', () => {
  it('reduced rate 5%, standard 20%, zero-rated 0%', async () => {
    const ex = await run({
      currency: 'GBP',
      lines: [
        { amount: 1999n, category: 'reduced' },
        { amount: 1999n, category: 'standard' },
        { amount: 1999n, category: 'zero' },
      ],
      to: addr('GB'),
      inclusive: false,
    });
    expect(taxes(ex)).toEqual([100n, 400n, 0n]); // 99.95 -> 100, 399.8 -> 400
    const inc = await run({
      currency: 'GBP',
      lines: [
        { amount: 2100n, category: 'reduced' },
        { amount: 1200n },
        { amount: 500n, category: 'zero' },
      ],
      to: addr('GB'),
      inclusive: true,
    });
    expect(taxes(inc)).toEqual([100n, 200n, 0n]);
    expect(inc.total.amount).toBe(300n);
  });
});

describe('zero-decimal and three-decimal currencies', () => {
  it('JPY (0 decimals): JP consumption tax 10% and 8% reduced', async () => {
    const ex = await run({
      currency: 'JPY',
      lines: [{ amount: 1050n }, { amount: 1005n }, { amount: 1000n, category: 'reduced' }],
      shipping: 500n,
      to: addr('JP'),
      inclusive: false,
    });
    expect(taxes(ex)).toEqual([105n, 101n, 80n]); // 100.5 -> 101
    expect(ex.shipping.tax.amount).toBe(50n);
    expect(ex.total.amount).toBe(336n);

    const inc = await run({
      currency: 'JPY',
      lines: [{ amount: 1100n }, { amount: 1099n }, { amount: 1080n, category: 'reduced' }],
      to: addr('JP'),
      inclusive: true,
    });
    expect(taxes(inc)).toEqual([100n, 100n, 80n]);
    expect(inc.total.currency).toBe('JPY');
  });

  it('KWD (3 decimals): exact minor-unit maths', async () => {
    const provider = createTaxProvider({
      rules: [
        { country: 'KW', category: 'standard', name: 'VAT', rateBps: 500, appliesToShipping: true },
      ],
    });
    const ex = await provider.calculate(
      input({
        currency: 'KWD',
        lines: [{ amount: 1500n }, { amount: 1234n }],
        shipping: 750n,
        to: addr('KW'),
        inclusive: false,
      }),
    );
    // 1.500 -> 0.075; 1.234 -> 0.0617 -> 0.062; shipping 0.750 -> 0.0375 -> 0.038
    expect(taxes(ex)).toEqual([75n, 62n]);
    expect(ex.shipping.tax.amount).toBe(38n);
    expect(ex.total.amount).toBe(175n);
    expect(ex.total.toString()).toBe('0.175 KWD');

    const inc = await provider.calculate(
      input({
        currency: 'KWD',
        lines: [{ amount: 1050n }, { amount: 1000n }],
        to: addr('KW'),
        inclusive: true,
      }),
    );
    expect(taxes(inc)).toEqual([50n, 48n]); // 47.619 -> 48
  });
});

describe('customer exempt / unknown country / categories', () => {
  it('a tax-exempt customer pays no tax and gets no components', async () => {
    for (const inclusive of [false, true]) {
      const r = await run({
        lines: [{ amount: 1000n }],
        shipping: 500n,
        to: addr('AU'),
        inclusive,
        exempt: true,
      });
      expect(r.total.amount).toBe(0n);
      expect(r.lines[0]?.rates).toEqual([]);
      expect(r.shipping.rates).toEqual([]);
      expect(r.breakdown).toEqual([]);
      expect(r.pricesIncludeTax).toBe(inclusive);
    }
  });

  it('a destination country with no rule is zero tax, not an error', async () => {
    const r = await run({
      lines: [{ amount: 12345n }],
      shipping: 999n,
      to: addr('BR'),
      inclusive: true,
    });
    expect(r.total.amount).toBe(0n);
    expect(r.breakdown).toEqual([]);
  });

  it('a region with no rule inside a covered country is also zero (no US nexus in Oregon)', async () => {
    const r = await run({
      lines: [{ amount: 1000n }],
      to: addr('US', 'OR'),
      from: addr('US', 'OR'),
      inclusive: false,
    });
    expect(r.total.amount).toBe(0n);
  });

  it('an unknown category falls back to standard; `exempt` without a rule stays untaxed', async () => {
    const gb = await run({
      currency: 'GBP',
      lines: [{ amount: 1000n, category: 'gizmo' }],
      to: addr('GB'),
      inclusive: false,
    });
    expect(taxes(gb)).toEqual([200n]);
    const us = await run({
      lines: [{ amount: 1000n, category: 'exempt' }],
      to: addr('US', 'CA'),
      from: addr('US', 'CA'),
      inclusive: false,
    });
    expect(taxes(us)).toEqual([0n]);
  });

  it('accepts negative (refund) amounts, rounding half away from zero', async () => {
    const r = await run({
      lines: [{ amount: -1000n }, { amount: -5n }],
      to: addr('AU'),
      inclusive: false,
    });
    expect(taxes(r)).toEqual([-100n, -1n]);
    expect(r.total.amount).toBe(-101n);
  });

  it('rejects mixed currencies and an invalid clock', async () => {
    const bad = input({ lines: [{ amount: 100n }], to: addr('AU'), inclusive: false });
    expect(() => defaultTaxProvider.calculate({ ...bad, shipping: Money.of(1n, 'USD') })).toThrow(
      /Currency mismatch/,
    );
    expect(() => defaultTaxProvider.calculate({ ...bad, now: new Date(Number.NaN) })).toThrow(
      RangeError,
    );
  });
});

describe('multiple components and origin sourcing', () => {
  it('US origin-based: NY state + local are summed with per-component rounding tracked', async () => {
    const r = await run({
      lines: [{ amount: 1999n }, { amount: 1999n }],
      to: addr('US', 'ny'), // destination region is irrelevant for origin sourcing
      from: addr('US', 'NY'),
      inclusive: false,
    });
    // each line: 1999 * 4% = 79.96 -> 80 ; 1999 * 4.5% = 89.955 -> 90
    expect(r.lines[0]?.rates.map((x) => [x.name, x.rate, x.amount.amount])).toEqual([
      ['NY state sales tax', 400, 80n],
      ['NY local sales tax (example)', 450, 90n],
    ]);
    expect(taxes(r)).toEqual([170n, 170n]);
    expect(r.total.amount).toBe(340n);
    expect(r.breakdown.map((b) => [b.name, b.rateBps, b.taxable.amount, b.amount.amount])).toEqual([
      ['NY local sales tax (example)', 450, 3998n, 180n],
      ['NY state sales tax', 400, 3998n, 160n],
    ]);
  });

  it('inclusive: the combined rate is extracted once and split by largest remainder', async () => {
    const r = await run({
      lines: [{ amount: 1999n }],
      to: addr('US', 'NY'),
      from: addr('US', 'NY'),
      inclusive: true,
    });
    // 1999 * 850 / 10850 = 156.6 -> 157; split 400:450 -> 73.88 / 83.11 -> [74, 83]
    expect(taxes(r)).toEqual([157n]);
    expect(r.lines[0]?.rates.map((x) => x.amount.amount)).toEqual([74n, 83n]);
    expect(r.breakdown.map((b) => b.taxable.amount)).toEqual([1842n, 1842n]); // net = 1999 - 157
  });

  it('origin sourcing needs the seller AND the buyer in the rule country', async () => {
    const base = { lines: [{ amount: 1000n }], inclusive: false };
    const wa = await run({ ...base, to: addr('US', 'NY'), from: addr('US', 'WA') });
    expect(wa.total.amount).toBe(65n);
    const tx = await run({ ...base, to: addr('US', 'NY'), from: addr('US', 'tx') });
    expect(tx.total.amount).toBe(63n); // 62.5 -> 63
    const foreignSeller = await run({ ...base, to: addr('US', 'NY'), from: addr('AU', 'NSW') });
    expect(foreignSeller.total.amount).toBe(0n);
    const foreignBuyer = await run({ ...base, to: addr('AU'), from: addr('US', 'NY') });
    expect(foreignBuyer.total.amount).toBe(100n); // AU destination rule, not the US origin rule
  });

  it('CA-style national GST plus a provincial PST both apply, in table order', async () => {
    const rules: TaxRuleInput[] = [
      { country: 'CA', category: 'standard', name: 'GST', rateBps: 500, appliesToShipping: true },
      {
        country: 'CA',
        region: 'BC',
        category: 'standard',
        name: 'PST',
        rateBps: 700,
        appliesToShipping: false,
      },
    ];
    const provider = createTaxProvider({ rules });
    const bc = await provider.calculate(
      input({
        currency: 'CAD',
        lines: [{ amount: 1000n }],
        shipping: 1000n,
        to: addr('CA', 'BC'),
        inclusive: false,
      }),
    );
    expect(bc.lines[0]?.rates.map((x) => [x.name, x.amount.amount])).toEqual([
      ['GST', 50n],
      ['PST', 70n],
    ]);
    expect(bc.shipping.tax.amount).toBe(50n); // GST only: PST does not apply to shipping
    expect(bc.total.amount).toBe(170n);
    const ab = await provider.calculate(
      input({
        currency: 'CAD',
        lines: [{ amount: 1000n }],
        to: addr('CA', 'AB'),
        inclusive: false,
      }),
    );
    expect(ab.total.amount).toBe(50n);
  });
});

describe('effective-dated rules', () => {
  const provider = createTaxProvider({
    rules: [
      {
        country: 'AU',
        category: 'standard',
        name: 'GST',
        rateBps: 1000,
        appliesToShipping: true,
        effectiveFrom: '2020-01-01',
        effectiveTo: '2027-01-01',
      },
      {
        country: 'AU',
        category: 'standard',
        name: 'GST',
        rateBps: 1200,
        appliesToShipping: true,
        effectiveFrom: '2027-01-01T00:00:00Z',
      },
    ],
  });
  const at = async (iso: string): Promise<bigint> =>
    (
      await provider.calculate(
        input({ lines: [{ amount: 1000n }], to: addr('AU'), inclusive: false, now: new Date(iso) }),
      )
    ).total.amount;

  it('effectiveFrom is inclusive, effectiveTo exclusive, and gaps mean no tax', async () => {
    expect(await at('2019-12-31T23:59:59.999Z')).toBe(0n);
    expect(await at('2020-01-01T00:00:00.000Z')).toBe(100n);
    expect(await at('2026-12-31T23:59:59.999Z')).toBe(100n);
    expect(await at('2027-01-01T00:00:00.000Z')).toBe(120n);
    expect(await at('2040-01-01T00:00:00.000Z')).toBe(120n);
  });
});

describe('table validation', () => {
  it('rejects malformed tables with a ZodError', () => {
    const rule = {
      country: 'AU',
      category: 'standard',
      name: 'GST',
      rateBps: 1000,
      appliesToShipping: true,
    };
    for (const bad of [
      { rules: [{ ...rule, rateBps: 10.5 }] },
      { rules: [{ ...rule, rateBps: -1 }] },
      { rules: [{ ...rule, rateBps: 10_001 }] },
      { rules: [{ ...rule, country: 'au' }] },
      { rules: [{ ...rule, appliesToShipping: undefined }] },
      { rules: [{ ...rule, effectiveFrom: 'yesterday' }] },
      { rules: [{ ...rule, effectiveFrom: '2027-01-01', effectiveTo: '2026-01-01' }] },
      { rules: [{ ...rule, typo: 1 }] },
      { rules: 'nope' },
    ]) {
      expect(() => createTaxProvider(bad as never)).toThrow(ZodError);
    }
  });
});
