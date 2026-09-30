import { Money } from '@sold/core';
import { describe, expect, it } from 'vitest';
import type { Address } from '../contracts';
import { defaultTaxProvider } from './default-provider';
import { createTaxProvider } from './provider';
import { defaultTaxTable } from './tables';
import type { TaxInput, TaxLineInput, TaxResult } from './types';

/** mulberry32: tiny seeded PRNG so every failure is reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Gen {
  constructor(private readonly next: () => number) {}
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }
  bool(): boolean {
    return this.next() < 0.5;
  }
  /** Non-negative bigint with a random number of digits (0..maxDigits). */
  amount(maxDigits: number): bigint {
    const digits = 1 + this.int(maxDigits);
    let s = '';
    for (let i = 0; i < digits; i++) s += String(this.int(10));
    return BigInt(s);
  }
}

const addr = (country: string, region = ''): Address => ({
  line1: '1 Test St',
  city: 'Testville',
  region,
  postalCode: '0000',
  country,
});

const destinations: { to: Address; from: Address; currency: string }[] = [
  { to: addr('AU', 'NSW'), from: addr('AU', 'NSW'), currency: 'AUD' },
  { to: addr('NZ'), from: addr('AU', 'NSW'), currency: 'NZD' },
  { to: addr('GB'), from: addr('GB'), currency: 'GBP' },
  { to: addr('JP'), from: addr('JP'), currency: 'JPY' },
  { to: addr('US', 'NY'), from: addr('US', 'NY'), currency: 'USD' },
  { to: addr('US', 'TX'), from: addr('US', 'CA'), currency: 'USD' },
  { to: addr('BR'), from: addr('AU'), currency: 'BRL' },
  { to: addr('AU'), from: addr('AU'), currency: 'KWD' },
];
const categories = ['standard', 'reduced', 'zero', 'exempt', 'mystery'] as const;

function randomInput(g: Gen): TaxInput {
  const d = g.pick(destinations);
  const lines: TaxLineInput[] = Array.from({ length: 1 + g.int(6) }, (_, i) => ({
    lineId: `l${i}`,
    net: Money.of(g.amount(g.pick([2, 5, 9, 15])), d.currency),
    taxCategory: g.pick(categories),
    quantity: 1 + g.int(5),
  }));
  return {
    currency: d.currency,
    lines,
    shipping: Money.of(g.bool() ? 0n : g.amount(7), d.currency),
    destination: d.to,
    origin: d.from,
    pricesIncludeTax: g.bool(),
    customerTaxExempt: g.int(10) === 0,
    now: new Date('2026-06-15T00:00:00Z'),
  };
}

const sum = (currency: string, values: Money[]): Money =>
  values.reduce((a, b) => a.add(b), Money.zero(currency));

const ITERATIONS = 1500;
const SEED = 20260615;

function forAll(check: (input: TaxInput, result: TaxResult) => void): void {
  const g = new Gen(prng(SEED));
  for (let i = 0; i < ITERATIONS; i++) {
    const input = randomInput(g);
    const result = defaultTaxProvider.calculate(input) as TaxResult;
    try {
      check(input, result);
    } catch (e) {
      throw new Error(`property failed at iteration ${i} (seed ${SEED})`, { cause: e });
    }
  }
}

describe('tax properties (seeded)', () => {
  it('total == sum of line taxes + shipping tax, and breakdown and components sum to it', () => {
    forAll((input, r) => {
      const c = input.currency;
      const parts = sum(c, [...r.lines.map((l) => l.tax), r.shipping.tax]);
      expect(r.total.equals(parts)).toBe(true);
      expect(
        sum(
          c,
          r.breakdown.map((b) => b.amount),
        ).equals(r.total),
      ).toBe(true);
      for (const l of r.lines)
        expect(
          sum(
            c,
            l.rates.map((x) => x.amount),
          ).equals(l.tax),
        ).toBe(true);
      expect(
        sum(
          c,
          r.shipping.rates.map((x) => x.amount),
        ).equals(r.shipping.tax),
      ).toBe(true);
      expect(r.lines.map((l) => l.lineId)).toEqual(input.lines.map((l) => l.lineId));
    });
  });

  it('inclusive: net + tax == gross for every line, with net in [0, gross] and tax within half a unit of exact', () => {
    forAll((input, r) => {
      if (!input.pricesIncludeTax) return;
      input.lines.forEach((line, i) => {
        const tax = (r.lines[i] as TaxResult['lines'][number]).tax;
        const net = line.net.subtract(tax);
        expect(net.add(tax).equals(line.net)).toBe(true);
        expect(net.amount >= 0n && net.amount <= line.net.amount).toBe(true);
        const combined = BigInt(
          (r.lines[i] as TaxResult['lines'][number]).rates.reduce((s, x) => s + x.rate, 0),
        );
        // |tax - gross*R/(10000+R)| <= 1/2, in integers: 2*|tax*(10000+R) - gross*R| <= 10000+R
        const diff = tax.amount * (10_000n + combined) - line.net.amount * combined;
        expect((diff < 0n ? -diff : diff) * 2n <= 10_000n + combined).toBe(true);
      });
    });
  });

  it('exclusive: each component is the half-up rounding of amount * rate / 10000', () => {
    forAll((input, r) => {
      if (input.pricesIncludeTax) return;
      input.lines.forEach((line, i) => {
        for (const x of (r.lines[i] as TaxResult['lines'][number]).rates) {
          const expected = (line.net.amount * BigInt(x.rate) * 2n + 10_000n) / 20_000n; // half-up, amount >= 0
          expect(x.amount.amount).toBe(expected);
        }
      });
    });
  });

  it('is never negative for non-negative amounts and zero for exempt customers', () => {
    forAll((input, r) => {
      expect(r.total.isNegative()).toBe(false);
      expect(r.shipping.tax.isNegative()).toBe(false);
      for (const l of r.lines) expect(l.tax.isNegative()).toBe(false);
      for (const b of r.breakdown) {
        expect(b.amount.isNegative() || b.taxable.isNegative()).toBe(false);
      }
      if (input.customerTaxExempt) expect(r.total.isZero()).toBe(true);
    });
  });

  it('is deterministic: same input, same output, across fresh providers and repeated calls', () => {
    const fresh = createTaxProvider(defaultTaxTable);
    forAll((input, r) => {
      expect(defaultTaxProvider.calculate(input)).toEqual(r);
      expect(fresh.calculate(input)).toEqual(r);
    });
  });

  it('is exact for huge bigint amounts (no float precision loss)', () => {
    const big = 10n ** 40n;
    const exclusive = defaultTaxProvider.calculate({
      currency: 'AUD',
      lines: [
        { lineId: 'a', net: Money.of(big + 7n, 'AUD'), taxCategory: 'standard', quantity: 1 },
      ],
      shipping: Money.of(big, 'AUD'),
      destination: addr('AU'),
      origin: addr('AU'),
      pricesIncludeTax: false,
      now: new Date('2026-06-15T00:00:00Z'),
    }) as TaxResult;
    // (10^40 + 7) / 10 = 10^39 + 0.7 -> 10^39 + 1
    expect(exclusive.lines[0]?.tax.amount).toBe(10n ** 39n + 1n);
    expect(exclusive.shipping.tax.amount).toBe(10n ** 39n);
    expect(exclusive.total.amount).toBe(2n * 10n ** 39n + 1n);

    const inclusive = defaultTaxProvider.calculate({
      currency: 'AUD',
      lines: [
        {
          lineId: 'a',
          net: Money.of(11n * 10n ** 30n, 'AUD'),
          taxCategory: 'standard',
          quantity: 1,
        },
      ],
      shipping: Money.zero('AUD'),
      destination: addr('AU'),
      origin: addr('AU'),
      pricesIncludeTax: true,
      now: new Date('2026-06-15T00:00:00Z'),
    }) as TaxResult;
    expect(inclusive.total.amount).toBe(10n ** 30n);
  });
});
