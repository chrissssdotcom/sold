import type { MoneyValue } from '@sold/extension-sdk';

/** Decimal places for a currency (JPY 0, AUD 2, KWD 3), from the platform's ICU data. Pure, no I/O. */
export function currencyExponent(currency: string): number {
  return (
    new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

/** Whole major units in a money value, e.g. 12_345 AUD cents -> 123. Never uses floats. */
export function majorUnits(total: MoneyValue): bigint {
  return total.amount / 10n ** BigInt(currencyExponent(total.currency));
}

/** Points earned: `perDollar` points for each whole major unit spent. */
export function pointsFor(total: MoneyValue, perDollar: number): bigint {
  return majorUnits(total) * BigInt(perDollar);
}

/**
 * ".99" charm pricing: round a price UP to the next price ending in .99 (or 9 for 0-decimal currencies is
 * left alone: there is no fractional part to charm). Zero stays zero.
 */
export function charmRound(minor: bigint, currency: string): bigint {
  const exp = currencyExponent(currency);
  if (exp === 0 || minor <= 0n) return minor;
  const unit = 10n ** BigInt(exp);
  const ending = unit - 1n; // .99 -> 99, .999 -> 999
  const base = minor - ending;
  if (base <= 0n) return ending;
  const wholeUnits = (base + unit - 1n) / unit; // ceil(base / unit)
  return wholeUnits * unit + ending;
}
