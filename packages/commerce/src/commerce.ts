import { CartService } from './cart';
import { CatalogService } from './catalog';
import {
  CheckoutService,
  QuoteService,
  defaultCheckoutConfig,
  type CheckoutConfig,
} from './checkout';
import { noHooks, type HookRunner } from './hooks';
import {
  InventoryService,
  PostgresReservationStrategy,
  type InventoryGate,
  type InventoryReservationStrategy,
} from './inventory';
import { OrderService } from './orders';
import { defaultPricingProvider, type PricingProvider } from './pricing';
import { PromotionService } from './promotions';
import { defaultShippingProvider, type ShippingProvider } from './shipping';
import { defaultTaxProvider, type TaxProvider } from './tax';

export interface CommerceOptions {
  /** Interceptor runner from the extension kernel (or `noHooks`). */
  hooks?: HookRunner;
  /** Replaceable services: default to the Base implementations; extensions may supply their own through the registry. */
  pricing?: PricingProvider;
  tax?: TaxProvider;
  shipping?: ShippingProvider;
  inventoryStrategy?: InventoryReservationStrategy;
  /** Set when `inventoryStrategy` is gated, so stock adjustments invalidate its counters. */
  inventoryGate?: InventoryGate;
  checkout?: Partial<CheckoutConfig>;
  onInvalidPromotion?: (id: string, error: unknown) => void;
}

/** Wires the commerce domain. One instance per process; all state lives in Postgres (stateless, horizontally scalable). */
export function createCommerce(opts: CommerceOptions = {}) {
  const hooks = opts.hooks ?? noHooks;
  const config: CheckoutConfig = { ...defaultCheckoutConfig, ...opts.checkout };
  const inventory = new InventoryService({
    strategy: opts.inventoryStrategy ?? new PostgresReservationStrategy(),
    ...(opts.inventoryGate ? { gate: opts.inventoryGate } : {}),
  });
  const carts = new CartService({ hooks });
  const promotions = new PromotionService();
  const quotes = new QuoteService({
    carts,
    promotions,
    pricing: opts.pricing ?? defaultPricingProvider,
    tax: opts.tax ?? defaultTaxProvider,
    shipping: opts.shipping ?? defaultShippingProvider,
    config,
    ...(opts.onInvalidPromotion ? { onInvalidPromotion: opts.onInvalidPromotion } : {}),
  });
  const orders = new OrderService(inventory);
  const checkout = new CheckoutService({ quotes, carts, inventory, config, hooks });
  return {
    catalog: new CatalogService(),
    inventory,
    carts,
    promotions,
    quotes,
    orders,
    checkout,
    config,
  };
}

export type Commerce = ReturnType<typeof createCommerce>;
