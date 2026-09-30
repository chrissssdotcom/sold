import type { Money } from '@sold/core';
import type { Address } from '../contracts';

/** One line handed to the tax engine. */
export interface TaxLineInput {
  lineId: string;
  /**
   * The post-discount line amount. When `pricesIncludeTax` is false this is the tax-exclusive amount and tax is
   * added on top; when true it is the tax-inclusive (gross) amount and tax is extracted from it.
   */
  net: Money;
  /** Tax category, e.g. `standard`, `reduced`, `zero`, `exempt`. */
  taxCategory: string;
  quantity: number;
}

export interface TaxInput {
  currency: string;
  lines: readonly TaxLineInput[];
  /** Post-discount shipping charge (tax-inclusive when `pricesIncludeTax`). */
  shipping: Money;
  destination: Address;
  /** Where the seller ships from. Only origin-sourced rules (e.g. simplified US sales tax) look at it. */
  origin: Address;
  pricesIncludeTax: boolean;
  customerTaxExempt?: boolean;
  /** Explicit clock so rules with effective dates are reproducible. */
  now: Date;
}

/** One tax component (e.g. "GST", or a state plus a local rate) and the amount it contributed. */
export interface TaxRateAmount {
  name: string;
  /** Rate in basis points: 1000 = 10%. */
  rate: number;
  amount: Money;
}

export interface TaxLineResult {
  lineId: string;
  tax: Money;
  rates: TaxRateAmount[];
}

export interface TaxBreakdownEntry {
  name: string;
  rateBps: number;
  /** Tax-exclusive base this component was applied to (summed over lines and shipping). */
  taxable: Money;
  amount: Money;
}

export interface TaxResult {
  lines: TaxLineResult[];
  shipping: { tax: Money; rates: TaxRateAmount[] };
  /** Total tax: exactly the sum of every line tax plus the shipping tax. */
  total: Money;
  /** Echo of the input flag, so consumers know whether `net` amounts already contained the tax. */
  pricesIncludeTax: boolean;
  /** Per (name, rate) totals, sorted by name then rate; the amounts sum exactly to `total`. */
  breakdown: TaxBreakdownEntry[];
}

/**
 * A tax calculator. Replaceable through the extension service registry (`tax`): an Avalara/TaxJar-style
 * extension can implement this and be async, but note the scale gate: no synchronous third-party call on the
 * cart/checkout path, so such providers must cache or run off the hot path.
 */
export interface TaxProvider {
  calculate(input: TaxInput): Promise<TaxResult> | TaxResult;
}
