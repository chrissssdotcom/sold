import { describe, expect, it } from 'vitest';
import { charmRound, currencyExponent, majorUnits, pointsFor } from './points';

describe('currency-aware money math', () => {
  it('knows exponents for 0, 2 and 3 decimal currencies', () => {
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('AUD')).toBe(2);
    expect(currencyExponent('KWD')).toBe(3);
  });

  it('counts whole major units without floats', () => {
    expect(majorUnits({ amount: 12_345n, currency: 'AUD' })).toBe(123n);
    expect(majorUnits({ amount: 12_345n, currency: 'JPY' })).toBe(12_345n);
    expect(majorUnits({ amount: 12_345n, currency: 'KWD' })).toBe(12n);
    expect(majorUnits({ amount: 9_007_199_254_740_993_00n, currency: 'AUD' })).toBe(
      9_007_199_254_740_993n,
    );
  });

  it('awards points per major unit', () => {
    expect(pointsFor({ amount: 12_345n, currency: 'AUD' }, 2)).toBe(246n);
    expect(pointsFor({ amount: 99n, currency: 'AUD' }, 5)).toBe(0n);
  });
});

describe('charmRound (.99 endings)', () => {
  it.each([
    [1000n, 'AUD', 1099n],
    [1099n, 'AUD', 1099n],
    [1100n, 'AUD', 1199n],
    [1n, 'AUD', 99n],
    [99n, 'AUD', 99n],
    [0n, 'AUD', 0n],
    [12_345n, 'AUD', 12_399n],
    [1000n, 'KWD', 1999n], // 3 decimals: .999
    [1000n, 'JPY', 1000n], // 0 decimals: nothing to charm
  ])('%s %s -> %s', (minor, currency, expected) =>
    expect(charmRound(minor, currency)).toBe(expected),
  );

  it('never rounds down', () => {
    for (let m = 1n; m < 1000n; m += 7n) expect(charmRound(m, 'AUD') >= m).toBe(true);
  });
});
