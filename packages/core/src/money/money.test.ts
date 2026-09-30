import { describe, expect, it } from 'vitest';
import {
  currencyExponent,
  isCurrency,
  minorPerMajor,
  supportedCurrencies,
  UnknownCurrencyError,
} from './currency';
import { CurrencyMismatchError, Money, parseDecimalRational } from './money';
import { divideRounded, type RoundingMode } from './rounding';

/** Deterministic PRNG (mulberry32) so property tests are reproducible. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randBig = (r: () => number, max: number) => BigInt(Math.floor(r() * max));

describe('currency exponents', () => {
  it('zero-, two- and three-decimal currencies', () => {
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KRW')).toBe(0);
    expect(currencyExponent('AUD')).toBe(2);
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('KWD')).toBe(3);
    expect(currencyExponent('BHD')).toBe(3);
    expect(minorPerMajor('KWD')).toBe(1000n);
  });

  it('rejects unknown, lower-case and malformed codes rather than guessing', () => {
    for (const bad of ['XYZ', 'aud', 'AU', '', 'AUDD', '__proto__', 'constructor']) {
      expect(isCurrency(bad), bad).toBe(false);
      expect(() => currencyExponent(bad), bad).toThrow(UnknownCurrencyError);
    }
  });

  it('every listed currency has a sane exponent', () => {
    for (const code of supportedCurrencies())
      expect([0, 2, 3, 4]).toContain(currencyExponent(code));
  });
});

describe('Money construction and formatting', () => {
  it('parses and prints exactly, per currency exponent', () => {
    expect(Money.parse('19.99', 'AUD').amount).toBe(1999n);
    expect(Money.parse('1000', 'JPY').amount).toBe(1000n);
    expect(Money.parse('1.234', 'KWD').amount).toBe(1234n);
    expect(Money.parse('5', 'AUD').toDecimalString()).toBe('5.00');
    expect(Money.of(1000n, 'JPY').toDecimalString()).toBe('1000');
    expect(Money.of(1234n, 'KWD').toDecimalString()).toBe('1.234');
  });

  it('never silently rounds input, and rejects garbage', () => {
    expect(() => Money.parse('19.999', 'AUD')).toThrow(/2 decimal places/);
    expect(() => Money.parse('10.5', 'JPY')).toThrow(/0 decimal places/);
    for (const bad of ['', 'abc', '1e3', '1,000.00', '--1', '1.', '.5'])
      expect(() => Money.parse(bad, 'AUD'), bad).toThrow(RangeError);
  });

  it('prints small and negative amounts correctly', () => {
    expect(Money.of(5n, 'AUD').toDecimalString()).toBe('0.05');
    expect(Money.of(-5n, 'AUD').toDecimalString()).toBe('-0.05');
    expect(Money.of(-1999n, 'AUD').toDecimalString()).toBe('-19.99');
    expect(Money.of(7n, 'KWD').toDecimalString()).toBe('0.007');
    expect(Money.zero('JPY').toDecimalString()).toBe('0');
  });

  it('handles amounts beyond Number.MAX_SAFE_INTEGER without loss', () => {
    const big = Money.of(9_007_199_254_740_993n, 'AUD');
    expect(big.add(Money.of(1n, 'AUD')).amount).toBe(9_007_199_254_740_994n);
    expect(big.toDecimalString()).toBe('90071992547409.93');
    expect(Money.fromJSON(JSON.parse(JSON.stringify(big))).equals(big)).toBe(true);
  });

  it('formats for display by locale (formatting only)', () => {
    expect(Money.of(1999n, 'AUD').format('en-AU')).toMatch(/19\.99/);
    expect(Money.of(1000n, 'JPY').format('ja-JP')).toMatch(/1,000/);
    expect(Money.of(1234n, 'KWD').format('en')).toMatch(/1\.234/);
  });

  it('JSON round trip and validation', () => {
    expect(Money.of(1999n, 'AUD').toJSON()).toEqual({ amount: '1999', currency: 'AUD' });
    expect(() => Money.fromJSON({ amount: 1.5, currency: 'AUD' })).toThrow(/integer/);
    expect(() => Money.fromJSON({ amount: '10', currency: 'ZZZ' })).toThrow(UnknownCurrencyError);
  });

  it('is immutable', () => {
    const m = Money.of(1n, 'AUD');
    expect(() => {
      (m as unknown as { amount: bigint }).amount = 2n;
    }).toThrow(TypeError);
  });
});

describe('arithmetic', () => {
  it('adds, subtracts, negates, compares within a currency', () => {
    const a = Money.of(1000n, 'AUD');
    const b = Money.of(250n, 'AUD');
    expect(a.add(b).amount).toBe(1250n);
    expect(a.subtract(b).amount).toBe(750n);
    expect(b.subtract(a).isNegative()).toBe(true);
    expect(a.negate().abs().equals(a)).toBe(true);
    expect(a.compare(b)).toBe(1);
    expect(b.compare(a)).toBe(-1);
    expect(a.compare(Money.of(1000n, 'AUD'))).toBe(0);
  });

  it('refuses to mix currencies, everywhere it matters', () => {
    const aud = Money.of(100n, 'AUD');
    const usd = Money.of(100n, 'USD');
    expect(() => aud.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => aud.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => aud.compare(usd)).toThrow(CurrencyMismatchError);
    expect(aud.equals(usd)).toBe(false); // equality is a question, not an error
  });

  it('multiplies by whole quantities exactly', () => {
    expect(Money.of(1999n, 'AUD').times(3).amount).toBe(5997n);
    expect(Money.of(1999n, 'AUD').times(0n).isZero()).toBe(true);
    expect(() => Money.of(1n, 'AUD').times(1.5)).toThrow(RangeError);
  });
});

describe('rounding modes (exact, no floats)', () => {
  const cases: [bigint, bigint, Record<RoundingMode, bigint>][] = [
    // n/d      floor   ceil    trunc   half-up  half-even
    [5n, 2n, { floor: 2n, ceil: 3n, trunc: 2n, 'half-up': 3n, 'half-even': 2n }], // 2.5
    [7n, 2n, { floor: 3n, ceil: 4n, trunc: 3n, 'half-up': 4n, 'half-even': 4n }], // 3.5
    [-5n, 2n, { floor: -3n, ceil: -2n, trunc: -2n, 'half-up': -3n, 'half-even': -2n }], // -2.5
    [-7n, 2n, { floor: -4n, ceil: -3n, trunc: -3n, 'half-up': -4n, 'half-even': -4n }], // -3.5
    [4n, 3n, { floor: 1n, ceil: 2n, trunc: 1n, 'half-up': 1n, 'half-even': 1n }], // 1.333
    [5n, 3n, { floor: 1n, ceil: 2n, trunc: 1n, 'half-up': 2n, 'half-even': 2n }], // 1.667
    [-4n, 3n, { floor: -2n, ceil: -1n, trunc: -1n, 'half-up': -1n, 'half-even': -1n }],
    [6n, 3n, { floor: 2n, ceil: 2n, trunc: 2n, 'half-up': 2n, 'half-even': 2n }], // exact
    [0n, 5n, { floor: 0n, ceil: 0n, trunc: 0n, 'half-up': 0n, 'half-even': 0n }],
  ];
  it.each(cases)('%s / %s', (n, d, expected) => {
    for (const mode of Object.keys(expected) as RoundingMode[])
      expect(divideRounded(n, d, mode), mode).toBe(expected[mode]);
  });

  it('half-even is unbiased over many .5 cases; half-up is not', () => {
    let up = 0n;
    let even = 0n;
    for (let n = 1n; n <= 199n; n += 2n) {
      up += divideRounded(n, 2n, 'half-up');
      even += divideRounded(n, 2n, 'half-even');
    }
    const exact = ((1n + 199n) * 100n) / 2n / 2n; // sum of n/2 over odd n in [1,199]
    expect(even).toBe(exact);
    expect(up).toBeGreaterThan(exact);
  });

  it('rejects a non-positive denominator', () => {
    expect(() => divideRounded(1n, 0n, 'floor')).toThrow(RangeError);
    expect(() => divideRounded(1n, -1n, 'floor')).toThrow(RangeError);
  });

  it('applies rates and basis points with explicit rounding (10% GST on A$19.99 = 1.999)', () => {
    const price = Money.of(1999n, 'AUD');
    expect(price.basisPoints(1000, 'half-up').amount).toBe(200n);
    expect(price.basisPoints(1000, 'floor').amount).toBe(199n);
    expect(price.multiply(parseDecimalRational('0.1'), 'ceil').amount).toBe(200n);
    expect(Money.of(-1999n, 'AUD').basisPoints(1000, 'half-up').amount).toBe(-200n);
  });

  it('parses decimal rationals exactly', () => {
    expect(parseDecimalRational('0.6543')).toEqual({ numerator: 6543n, denominator: 10_000n });
    expect(parseDecimalRational('150')).toEqual({ numerator: 150n, denominator: 1n });
    expect(() => parseDecimalRational('1e-3')).toThrow(RangeError);
  });
});

describe('allocate / split: never lose or invent a minor unit', () => {
  it('splits an odd amount fairly and deterministically', () => {
    expect(
      Money.of(100n, 'AUD')
        .split(3)
        .map((m) => m.amount),
    ).toEqual([34n, 33n, 33n]);
    expect(
      Money.of(1n, 'AUD')
        .split(3)
        .map((m) => m.amount),
    ).toEqual([1n, 0n, 0n]);
    expect(
      Money.of(-100n, 'AUD')
        .split(3)
        .map((m) => m.amount),
    ).toEqual([-34n, -33n, -33n]);
  });

  it('allocates proportionally by weight (discount across lines)', () => {
    // A$10.00 discount across lines worth 3, 3 and 4 dollars
    expect(
      Money.of(1000n, 'AUD')
        .allocate([300n, 300n, 400n])
        .map((m) => m.amount),
    ).toEqual([300n, 300n, 400n]);
    expect(
      Money.of(100n, 'AUD')
        .allocate([1n, 1n, 1n, 0n])
        .map((m) => m.amount),
    ).toEqual([34n, 33n, 33n, 0n]);
    expect(
      Money.of(10n, 'AUD')
        .allocate([1n, 2n])
        .map((m) => m.amount),
    ).toEqual([3n, 7n]);
  });

  it('property: parts always sum to the whole, all non-negative for non-negative input, for random inputs', () => {
    const r = rng(42);
    for (let i = 0; i < 2_000; i++) {
      const total = randBig(r, 1_000_000) - (r() < 0.3 ? 500_000n : 0n);
      const n = 1 + Math.floor(r() * 12);
      const weights: bigint[] = Array.from({ length: n }, () => randBig(r, 1000));
      if (!weights.some((w) => w !== 0n)) weights[0] = 1n;
      const money = Money.of(total, 'AUD');
      const parts = money.allocate(weights);
      expect(
        parts.reduce((a, p) => a + p.amount, 0n),
        `total=${total} weights=${weights}`,
      ).toBe(total);
      expect(parts.length).toBe(n);
      for (const [idx, p] of parts.entries()) {
        if (weights[idx] === 0n) expect(p.amount === 0n || false).toBe(true); // zero weight gets nothing
        if (total >= 0n) expect(p.amount >= 0n).toBe(true);
      }
    }
  });

  it('property: each part is within one minor unit of its exact proportional share', () => {
    const r = rng(7);
    for (let i = 0; i < 1_000; i++) {
      const total = randBig(r, 100_000);
      const weights = Array.from({ length: 1 + Math.floor(r() * 8) }, () => 1n + randBig(r, 500));
      const sum = weights.reduce((a, b) => a + b, 0n);
      Money.of(total, 'AUD')
        .allocate(weights)
        .forEach((p, idx) => {
          const exactFloor = (total * (weights[idx] as bigint)) / sum;
          expect(p.amount === exactFloor || p.amount === exactFloor + 1n).toBe(true);
        });
    }
  });

  it('rejects impossible allocations', () => {
    expect(() => Money.of(1n, 'AUD').allocate([])).toThrow(RangeError);
    expect(() => Money.of(1n, 'AUD').allocate([0n, 0n])).toThrow(RangeError);
    expect(() => Money.of(1n, 'AUD').allocate([1n, -1n])).toThrow(RangeError);
    expect(() => Money.of(1n, 'AUD').split(0)).toThrow(RangeError);
  });
});

describe('currency conversion', () => {
  const rate = (s: string) => parseDecimalRational(s);

  it('AUD -> USD at 0.6543 rounds once, half-up', () => {
    // A$100.00 * 0.6543 = US$65.43
    expect(Money.of(10_000n, 'AUD').convert(rate('0.6543'), 'USD', 'half-up').amount).toBe(6543n);
    // A$19.99 * 0.6543 = 13.079457 -> US$13.08
    expect(Money.of(1999n, 'AUD').convert(rate('0.6543'), 'USD', 'half-up').amount).toBe(1308n);
  });

  it('accounts for different exponents: AUD -> JPY (0 decimals) and AUD -> KWD (3 decimals)', () => {
    // A$10.00 * 100 yen/AUD = 1000 yen
    const yen = Money.of(1000n, 'AUD').convert(rate('100'), 'JPY', 'half-up');
    expect(yen).toMatchObject({ amount: 1000n, currency: 'JPY' });
    // A$10.00 * 0.2 KWD/AUD = 2.000 KWD = 2000 fils
    const kwd = Money.of(1000n, 'AUD').convert(rate('0.2'), 'KWD', 'half-up');
    expect(kwd).toMatchObject({ amount: 2000n, currency: 'KWD' });
    // JPY -> AUD: 1000 yen * 0.01 = A$10.00
    expect(Money.of(1000n, 'JPY').convert(rate('0.01'), 'AUD', 'half-up').amount).toBe(1000n);
    // KWD -> JPY: 1.000 KWD * 480 = 480 yen
    expect(Money.of(1000n, 'KWD').convert(rate('480'), 'JPY', 'half-up').amount).toBe(480n);
  });

  it('rounding mode is honoured and the rate must be positive', () => {
    const m = Money.of(1n, 'USD'); // US$0.01
    expect(m.convert(rate('0.5'), 'AUD', 'floor').amount).toBe(0n);
    expect(m.convert(rate('0.5'), 'AUD', 'ceil').amount).toBe(1n);
    expect(() => m.convert({ numerator: 0n, denominator: 1n }, 'AUD', 'floor')).toThrow(RangeError);
    expect(() => m.convert({ numerator: 1n, denominator: 0n }, 'AUD', 'floor')).toThrow(RangeError);
    expect(() => m.convert(rate('1'), 'ZZZ', 'floor')).toThrow(UnknownCurrencyError);
  });

  it('property: converting there and back never drifts by more than the rounding of each leg', () => {
    const r = rng(99);
    for (let i = 0; i < 1_000; i++) {
      const cents = randBig(r, 10_000_000);
      const fx = { numerator: 1n + randBig(r, 5_000), denominator: 1_000n };
      const there = Money.of(cents, 'AUD').convert(fx, 'USD', 'half-even');
      const back = there.convert(
        { numerator: fx.denominator, denominator: fx.numerator },
        'AUD',
        'half-even',
      );
      // one minor unit of USD is worth at most 1/rate AUD units: allow that plus one for the return leg
      const tolerance = (fx.denominator + fx.numerator - 1n) / fx.numerator + 1n;
      const drift = back.amount > cents ? back.amount - cents : cents - back.amount;
      expect(
        drift <= tolerance,
        `cents=${cents} fx=${fx.numerator}/${fx.denominator} drift=${drift}`,
      ).toBe(true);
    }
  });
});
