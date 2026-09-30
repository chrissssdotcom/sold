import { describe, expect, it } from 'vitest';
import { parseRoundingRule } from './rounding';

const r = (rule: string | undefined, currency: string, minor: bigint) =>
  parseRoundingRule(rule, currency)(minor);

describe('rounding rules', () => {
  it('none leaves the amount alone', () => {
    expect(r(undefined, 'USD', 1234n)).toBe(1234n);
    expect(r('none', 'USD', 1234n)).toBe(1234n);
  });

  it('.99 picks the nearest x.99, ties up, never drifting more than half a unit', () => {
    expect(r('.99', 'USD', 1234n)).toBe(1199n); // 12.34: 11.99 is 0.35 away, 12.99 is 0.65 away
    expect(r('.99', 'USD', 1248n)).toBe(1199n);
    expect(r('.99', 'USD', 1249n)).toBe(1299n); // exact tie rounds up
    expect(r('.99', 'USD', 1250n)).toBe(1299n);
    expect(r('.99', 'USD', 1299n)).toBe(1299n);
    expect(r('.99', 'USD', 1300n)).toBe(1299n);
    expect(r('.99', 'USD', 1400n)).toBe(1399n);
  });

  it('never rounds a positive price to zero or below the first valid ending', () => {
    expect(r('.99', 'USD', 5n)).toBe(99n);
    expect(r('.99', 'USD', 0n)).toBe(0n);
    expect(r('step:5', 'AUD', 1n)).toBe(5n);
  });

  it('ending works for zero- and three-decimal currencies', () => {
    expect(r('ending:9/10', 'JPY', 984n)).toBe(989n);
    expect(r('ending:9/10', 'JPY', 981n)).toBe(979n);
    expect(r('ending:990/1000', 'KWD', 12_345n)).toBe(11_990n);
  });

  it('step is half-up cash rounding', () => {
    expect([1n, 2n, 3n, 7n, 8n, 12n].map((a) => r('step:5', 'AUD', a))).toEqual([
      5n,
      5n,
      5n,
      5n,
      10n,
      10n,
    ]);
    expect(r('step:5', 'AUD', 1002n)).toBe(1000n);
    expect(r('step:5', 'AUD', 1003n)).toBe(1005n);
  });

  it('property: result is within half a modulus of the input and matches the ending', () => {
    for (let a = 100n; a < 20_000n; a += 7n) {
      const v = r('.99', 'USD', a);
      expect(v % 100n).toBe(99n);
      expect(v - a <= 50n && a - v <= 50n).toBe(true);
    }
  });

  it('rejects rules that do not fit the currency or are unknown', () => {
    expect(() => parseRoundingRule('.99', 'JPY')).toThrow(/0 decimals/);
    expect(() => parseRoundingRule('.99', 'KWD')).toThrow(/3 decimals/);
    expect(() => parseRoundingRule('banana', 'USD')).toThrow(/Unknown/);
    expect(() => parseRoundingRule('ending:100/100', 'USD')).toThrow();
    expect(() => parseRoundingRule('step:0', 'USD')).toThrow();
  });
});
