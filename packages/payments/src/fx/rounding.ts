import { currencyExponent } from '@sold/core';

/**
 * How a converted price is finished. Exact bigint arithmetic on minor units; the result is always a non-negative
 * multiple structure defined by the rule, and never zero for a positive input (a free product is never an accident).
 *
 *   none              nearest minor unit (already exact: the conversion rounded half-up)
 *   ending:E/M        price ends in E minor units modulo M: `ending:99/100` = x.99, `ending:9/10` = ...9 (JPY 980)
 *   .99               sugar for `ending:99/100`; the digit count must equal the currency's decimals
 *   step:S            round half-up to a multiple of S minor units (`step:5` = 5c cash rounding for AUD)
 *
 * `ending` picks the NEAREST price of that form (ties round up), so a conversion never drifts by more than half a
 * modulus from the exact value.
 */
export type RoundingRule = (amountMinor: bigint) => bigint;

export function parseRoundingRule(rule: string | undefined, currency: string): RoundingRule {
  const text = (rule ?? 'none').trim();
  if (text === 'none' || text === '') return (a) => a;

  const dot = /^\.(\d+)$/.exec(text);
  if (dot) {
    const digits = dot[1] as string;
    if (digits.length !== currencyExponent(currency))
      throw new RangeError(
        `Rounding "${text}" needs ${currencyExponent(currency)} decimals for ${currency}`,
      );
    return ending(BigInt(digits), 10n ** BigInt(digits.length));
  }
  const end = /^ending:(\d+)\/(\d+)$/.exec(text);
  if (end) {
    const e = BigInt(end[1] as string);
    const m = BigInt(end[2] as string);
    if (m < 2n || e >= m) throw new RangeError(`Invalid ending rule "${text}"`);
    return ending(e, m);
  }
  const step = /^step:(\d+)$/.exec(text);
  if (step) {
    const s = BigInt(step[1] as string);
    if (s < 1n) throw new RangeError(`Invalid step rule "${text}"`);
    return (a) => {
      const r = ((a + s / 2n) / s) * s;
      return a > 0n && r === 0n ? s : r;
    };
  }
  throw new RangeError(`Unknown rounding rule "${text}"`);
}

function ending(e: bigint, m: bigint): RoundingRule {
  return (a) => {
    if (a <= 0n) return a;
    // Nearest value v with v ≡ e (mod m), v >= e (a price below the first valid ending clamps up to it).
    const below = ((a - e) / m) * m + e; // largest ≤ a (when a >= e)
    if (a < e) return e;
    const above = below + m;
    return a - below < above - a ? below : above; // tie → above
  };
}
