/**
 * Overridable implementations of Base interfaces. Extensions register providers by key; configuration
 * (or precedence) selects the active one. Later phases add their contracts here by interface merging:
 * `tax.calculator`, `shipping.rates`, `search`, `payment.gateway`, `email.transport`.
 *
 * Precedence: instance extension > first-party extension > Base default (docs/extending.md).
 */
export interface ServiceMap {
  /** Currency-aware rounding of derived prices, e.g. ".99" endings (Section 5.3). */
  'pricing.rounding': {
    /** `minor` is in the currency's minor units. */
    round(minor: bigint, currency: string): bigint;
  };
}

export type ServiceName = keyof ServiceMap;

export interface ServiceProvider<K extends ServiceName = ServiceName> {
  service: K;
  /** Provider key, unique per service, selectable in config (e.g. `charm-pricing`). */
  key: string;
  create(): ServiceMap[K] | Promise<ServiceMap[K]>;
}
