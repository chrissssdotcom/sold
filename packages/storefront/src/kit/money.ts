/** Wire format of money from the API: minor units as a decimal string plus the ISO code. */
export interface MoneyJson {
  amount: string;
  currency: string;
}

/** Decimal places of a currency, from the platform's own Intl data (works on server and client). */
export function exponentOf(currency: string, tag = 'en'): number {
  return (
    new Intl.NumberFormat(tag, { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

/**
 * Format minor units for display. BigInt arithmetic splits whole and fractional parts, so a 19-digit amount never
 * passes through a float; Intl then only formats the digits it is given.
 */
export function formatMoney(money: MoneyJson | undefined | null, tag: string): string {
  if (!money) return '';
  const exp = exponentOf(money.currency, tag);
  const minor = BigInt(money.amount);
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const base = 10n ** BigInt(exp);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(exp, '0');
  const decimal = exp === 0 ? whole.toString() : `${whole}.${frac}`;
  const formatted = new Intl.NumberFormat(tag, {
    style: 'currency',
    currency: money.currency,
  }).format(
    decimal as unknown as number, // Intl accepts decimal strings exactly (ES2023); typed as number in lib.d.ts
  );
  return negative ? `-${formatted}` : formatted;
}

export function toNumberMinor(m: MoneyJson): bigint {
  return BigInt(m.amount);
}
