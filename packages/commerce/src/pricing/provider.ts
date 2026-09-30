import { computePricing, type PricedCart, type PricingInput } from './engine';

/**
 * The replaceable pricing service (`pricing` in the extension service registry). Implementations must be pure and
 * deterministic for a given input (checkout recomputes at placement and snapshots the result).
 */
export interface PricingProvider {
  compute(input: PricingInput): Promise<PricedCart> | PricedCart;
}

/** Base implementation: the promotion engine in `./engine`. */
export const defaultPricingProvider: PricingProvider = {
  compute: (input) => computePricing(input),
};
