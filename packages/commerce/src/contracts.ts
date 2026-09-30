import type { Money } from '@sold/core';

/**
 * Cross-module contracts for the commerce domain. Pricing, tax and shipping are pure and deterministic
 * (no I/O, no clock except an explicit `now`), so checkout can recompute them at placement and snapshot the
 * result. Providers are replaceable through the extension service registry (`pricing`, `tax`, `shipping`).
 */

/** ISO 3166-1 alpha-2 country, free-form region (state/province code), postal code. */
export interface Address {
  name?: string;
  line1: string;
  line2?: string;
  city: string;
  /** State/province/territory code, e.g. `NSW`, `CA`. Empty where a country has none. */
  region: string;
  postalCode: string;
  country: string;
}

/** One cart line as the pricing/tax/shipping engines see it. */
export interface PricingLine {
  /** Stable id of the line within this calculation. */
  lineId: string;
  variantId: string;
  sku: string;
  title: string;
  quantity: number;
  /** List price per unit in the cart currency. */
  unitPrice: Money;
  weightGrams: number;
  /** Product ids/tags/collections the promotion rules can target. */
  productId: string;
  tags: readonly string[];
  /** Tax category (e.g. `standard`, `exempt`, `food`). Defaults to `standard`. */
  taxCategory?: string;
}
