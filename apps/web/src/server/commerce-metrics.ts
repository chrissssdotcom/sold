import { Counter, Histogram } from 'prom-client';
import { getRuntime } from './runtime';

export interface CommerceMetrics {
  inventoryGate: Counter<'event'>;
  checkout: Counter<'outcome'>;
  checkoutDuration: Histogram;
}

const holder = globalThis as unknown as { __soldCommerceMetrics?: CommerceMetrics };

/** Registered once per process on the runtime's registry (kept out of metrics.ts so the domain owns its own series). */
export function getCommerceMetrics(): CommerceMetrics {
  if (!holder.__soldCommerceMetrics) {
    const registers = [getRuntime().metrics.registry];
    holder.__soldCommerceMetrics = {
      inventoryGate: new Counter({
        name: 'sold_inventory_gate_events_total',
        help: 'Inventory admission gate events: rejected (sold out at the gate), passed, seeded, redis_error (failed open).',
        labelNames: ['event'],
        registers,
      }),
      checkout: new Counter({
        name: 'sold_checkout_total',
        help: 'Checkout outcomes: placed, replayed, or the stable error code that refused it.',
        labelNames: ['outcome'],
        registers,
      }),
      checkoutDuration: new Histogram({
        name: 'sold_checkout_duration_seconds',
        help: 'Time to place an order (quote, hooks and order transaction).',
        buckets: [0.025, 0.05, 0.1, 0.25, 0.4, 0.5, 1, 2.5, 5, 10],
        registers,
      }),
    };
  }
  return holder.__soldCommerceMetrics;
}
