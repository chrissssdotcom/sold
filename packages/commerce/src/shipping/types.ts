import type { Money } from '@sold/core';
import type { Address } from '../contracts';

export interface ShippingLineInput {
  lineId: string;
  quantity: number;
  /** Weight of ONE unit, in grams (a non-negative safe integer). */
  weightGrams: number;
  unitPrice: Money;
}

export interface ShippingQuoteInput {
  currency: string;
  destination: Address;
  lines: readonly ShippingLineInput[];
  /** Post-discount merchandise subtotal, in `currency`. */
  subtotal: Money;
  /** A free-shipping promotion applies to this order. */
  freeShippingPromo: boolean;
  /** Explicit clock for providers with time-dependent rates. */
  now: Date;
}

export interface ShippingQuote {
  methodId: string;
  label: string;
  amount: Money;
  estimatedDaysMin: number;
  estimatedDaysMax: number;
  carrier?: string;
}

/**
 * A shipping rate provider. Replaceable through the extension service registry (`shipping`). An EMPTY result means
 * the order cannot be shipped to that destination in that currency: checkout must refuse rather than guess.
 * Quotes come back ordered by price then method id, so the first is always the cheapest.
 */
export interface ShippingProvider {
  quote(input: ShippingQuoteInput): Promise<ShippingQuote[]> | ShippingQuote[];
}
