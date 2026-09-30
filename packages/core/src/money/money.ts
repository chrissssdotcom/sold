import { currencyExponent, minorPerMajor } from './currency';
import { divideRounded, type RoundingMode } from './rounding';

/**
 * Money: an integer amount of MINOR units plus an ISO-4217 currency. Immutable. There are no floats anywhere:
 * every operation is exact bigint arithmetic, and every operation that can produce a fraction takes an explicit
 * rounding mode (there is no default), so rounding is always a decision you can see in the code.
 *
 * Money in different currencies can never be added, subtracted or compared by accident: those operations throw
 * `CurrencyMismatchError`. Conversion between currencies is explicit (`convert`) and takes a rate.
 */
export class CurrencyMismatchError extends Error {
  constructor(
    public readonly left: string,
    public readonly right: string,
  ) {
    super(`Currency mismatch: ${left} vs ${right}`);
    this.name = 'CurrencyMismatchError';
  }
}

/** A rational number, e.g. an FX rate or a tax rate. `denominator` must be positive. */
export interface Rational {
  numerator: bigint;
  denominator: bigint;
}

/** Parse a decimal string such as "0.6543" or "1.1" into an exact rational (no float involved). */
export function parseDecimalRational(text: string): Rational {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new RangeError(`Not a decimal number: "${text}"`);
  const [, sign, whole, frac = ''] = m;
  const numerator = BigInt(`${whole}${frac}`) * (sign === '-' ? -1n : 1n);
  return { numerator, denominator: 10n ** BigInt(frac.length) };
}

export class Money {
  private constructor(
    readonly amount: bigint,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** From minor units (cents). `Money.of(1999n, 'AUD')` is A$19.99. */
  static of(amount: bigint, currency: string): Money {
    currencyExponent(currency); // validates the code
    return new Money(amount, currency);
  }

  static zero(currency: string): Money {
    return Money.of(0n, currency);
  }

  /**
   * From a decimal major-unit string: `Money.parse('19.99', 'AUD')`. More decimals than the currency allows is an
   * error (never silently rounded): `Money.parse('19.999', 'AUD')` throws, `Money.parse('1000', 'JPY')` is fine.
   */
  static parse(text: string, currency: string): Money {
    const exp = currencyExponent(currency);
    const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
    if (!m) throw new RangeError(`Not a money amount: "${text}"`);
    const [, sign, whole, frac = ''] = m;
    if (frac.length > exp)
      throw new RangeError(`${currency} has ${exp} decimal places, got "${text}"`);
    const minor = BigInt(`${whole}${frac.padEnd(exp, '0')}`);
    return Money.of(sign === '-' ? -minor : minor, currency);
  }

  private same(other: Money): void {
    if (this.currency !== other.currency)
      throw new CurrencyMismatchError(this.currency, other.currency);
  }

  add(other: Money): Money {
    this.same(other);
    return new Money(this.amount + other.amount, this.currency);
  }

  subtract(other: Money): Money {
    this.same(other);
    return new Money(this.amount - other.amount, this.currency);
  }

  negate(): Money {
    return new Money(-this.amount, this.currency);
  }

  abs(): Money {
    return this.amount < 0n ? this.negate() : this;
  }

  /** Multiply by a whole number (quantity). Exact. */
  times(quantity: bigint | number): Money {
    if (typeof quantity === 'number' && !Number.isSafeInteger(quantity))
      throw new RangeError('quantity must be a safe integer');
    return new Money(this.amount * BigInt(quantity), this.currency);
  }

  /** Multiply by a rational (tax rate, discount fraction) and round explicitly. */
  multiply(factor: Rational, mode: RoundingMode): Money {
    return new Money(
      divideRounded(this.amount * factor.numerator, factor.denominator, mode),
      this.currency,
    );
  }

  /** `percent` as basis points: `percentage(1000, 'half-up')` is 10%. Exact. */
  basisPoints(bps: bigint | number, mode: RoundingMode): Money {
    return this.multiply({ numerator: BigInt(bps), denominator: 10_000n }, mode);
  }

  compare(other: Money): -1 | 0 | 1 {
    this.same(other);
    return this.amount < other.amount ? -1 : this.amount > other.amount ? 1 : 0;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amount === other.amount;
  }

  isZero(): boolean {
    return this.amount === 0n;
  }

  isNegative(): boolean {
    return this.amount < 0n;
  }

  /**
   * Split into parts proportional to `weights` without losing or inventing a single minor unit: the parts always sum
   * to exactly this amount. Remainder units go to the largest fractional shares first (largest-remainder method),
   * ties broken by position, so the result is deterministic. Use for discounts across lines, tax across lines and
   * splitting shipping.
   */
  allocate(weights: readonly bigint[]): Money[] {
    if (weights.length === 0) throw new RangeError('allocate needs at least one weight');
    if (weights.some((w) => w < 0n)) throw new RangeError('weights must not be negative');
    const total = weights.reduce((a, b) => a + b, 0n);
    if (total === 0n) throw new RangeError('at least one weight must be positive');
    const sign = this.amount < 0n ? -1n : 1n;
    const magnitude = this.amount * sign;
    const shares = weights.map((w) => (magnitude * w) / total);
    let leftover = magnitude - shares.reduce((a, b) => a + b, 0n);
    const order = weights
      .map((w, i) => ({ i, remainder: (magnitude * w) % total }))
      .sort((a, b) =>
        a.remainder === b.remainder ? a.i - b.i : a.remainder > b.remainder ? -1 : 1,
      );
    for (const { i } of order) {
      if (leftover === 0n) break;
      shares[i] = (shares[i] as bigint) + 1n;
      leftover -= 1n;
    }
    return shares.map((s) => new Money(s * sign, this.currency));
  }

  /** Split into `n` near-equal parts (the first parts get the extra unit). */
  split(n: number): Money[] {
    if (!Number.isInteger(n) || n < 1) throw new RangeError('n must be a positive integer');
    return this.allocate(Array.from({ length: n }, () => 1n));
  }

  /**
   * Convert to another currency: `amount * rate`, corrected for the two currencies' different minor-unit exponents
   * (JPY has none, KWD has three), rounded once with the given mode. `rate` is target-major-units per source-major-unit.
   */
  convert(rate: Rational, target: string, mode: RoundingMode): Money {
    if (rate.numerator <= 0n || rate.denominator <= 0n)
      throw new RangeError('FX rate must be positive');
    const scaleUp = minorPerMajor(target);
    const scaleDown = minorPerMajor(this.currency);
    return new Money(
      divideRounded(this.amount * rate.numerator * scaleUp, rate.denominator * scaleDown, mode),
      target,
    );
  }

  /** Decimal major-unit string with exactly the currency's decimals: `1999n AUD -> "19.99"`, `1000n JPY -> "1000"`. */
  toDecimalString(): string {
    const exp = currencyExponent(this.currency);
    const negative = this.amount < 0n;
    const digits = (negative ? -this.amount : this.amount).toString().padStart(exp + 1, '0');
    const whole = digits.slice(0, digits.length - exp);
    const frac = digits.slice(digits.length - exp);
    return `${negative ? '-' : ''}${whole}${exp > 0 ? `.${frac}` : ''}`;
  }

  /** Locale-aware display, e.g. `format('en-AU') -> "$19.99"`. Formatting only: never parse this back. */
  format(locale: string): string {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: this.currency }).format(
      this.toDecimalString() as unknown as number,
    );
  }

  toJSON(): { amount: string; currency: string } {
    return { amount: this.amount.toString(), currency: this.currency };
  }

  static fromJSON(value: { amount: string | number | bigint; currency: string }): Money {
    if (typeof value.amount === 'number' && !Number.isSafeInteger(value.amount))
      throw new RangeError('amount must be an integer number of minor units');
    return Money.of(BigInt(value.amount), value.currency);
  }

  toString(): string {
    return `${this.toDecimalString()} ${this.currency}`;
  }
}
