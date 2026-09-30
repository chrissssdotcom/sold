/** How to resolve a fractional minor unit. */
export type RoundingMode =
  /** Away from zero at exactly .5 (what shoppers expect on receipts). */
  | 'half-up'
  /** To the even neighbour at exactly .5 (banker's rounding; unbiased over many operations). */
  | 'half-even'
  /** Toward negative infinity. */
  | 'floor'
  /** Toward positive infinity. */
  | 'ceil'
  /** Toward zero. */
  | 'trunc';

/**
 * Divide `numerator / denominator` (bigint, denominator > 0) to an integer with the given rounding, exactly:
 * no floats are involved at any point.
 */
export function divideRounded(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator <= 0n) throw new RangeError('denominator must be positive');
  const quotient = numerator / denominator; // truncates toward zero
  const remainder = numerator % denominator; // same sign as numerator
  if (remainder === 0n) return quotient;
  const negative = numerator < 0n;
  const twice = (negative ? -remainder : remainder) * 2n;
  switch (mode) {
    case 'trunc':
      return quotient;
    case 'floor':
      return negative ? quotient - 1n : quotient;
    case 'ceil':
      return negative ? quotient : quotient + 1n;
    case 'half-up':
      return twice >= denominator ? (negative ? quotient - 1n : quotient + 1n) : quotient;
    case 'half-even': {
      if (twice > denominator) return negative ? quotient - 1n : quotient + 1n;
      if (twice < denominator) return quotient;
      return quotient % 2n === 0n ? quotient : negative ? quotient - 1n : quotient + 1n;
    }
  }
}
