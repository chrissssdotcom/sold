/**
 * Two kinds of subscribers (Section 4):
 *  - **Observers** react to facts (`EventMap`). Asynchronous, non-blocking, retried through the job queue.
 *    They can never delay or fail the request that caused the event.
 *  - **Interceptors** take part in a decision (`HookMap`). Synchronous, ordered, time-boxed, and able to
 *    modify or veto. They run on hot paths, so they are heavily constrained (see `InterceptorContext`).
 */

export interface MoneyValue {
  /** Minor units. Never a float. */
  amount: bigint;
  currency: string;
}

/** Facts. Payloads are JSON-serialisable through Base's codec (bigint and Date survive). */
export interface EventMap {
  'cart.updated': { cartId: string; itemCount: number; subtotal: MoneyValue };
  'order.placed': {
    orderId: string;
    orderNumber: string;
    customerId: string | null;
    total: MoneyValue;
    placedAt: Date;
  };
  'payment.captured': { paymentId: string; orderId: string; amount: MoneyValue; gateway: string };
  /** Every order state change (paid, shipped, cancelled, refunded, ...). */
  'order.status_changed': {
    orderId: string;
    from: string;
    to: string;
    actor: string;
    /** True when payment landed but the stock could not be re-secured: needs a human. */
    stockShortfall: boolean;
  };
}

export type EventName = keyof EventMap;

export interface ObserverContextLike {
  /** Stable id of this delivery; the same across retries. Use it to dedupe side effects. */
  eventId: string;
  attempt: number;
}

export interface ObserverDefinition<E extends EventName = EventName, C = unknown> {
  event: E;
  /** Unique within the extension. Part of the retry/dedupe key. */
  name: string;
  handler(payload: EventMap[E], ctx: C & ObserverContextLike): Promise<void>;
}

/** Decisions. `modify` is validated by Base against the hook's own schema before it is applied. */
export interface HookMap {
  /** Before an item is added to a cart. Modify quantity, or veto (purchase limits, drop rules). */
  'cart.item.adding': {
    payload: { cartId: string; variantId: string; quantity: number };
    modify: { quantity?: number };
  };
  /** Before an order is placed. Veto only (fraud rules, drop eligibility). */
  'checkout.placing': {
    payload: { cartId: string; customerId: string | null; total: MoneyValue; itemCount: number };
    modify: Record<string, never>;
  };
}

export type HookName = keyof HookMap;

export interface Veto {
  /** Machine-readable, stable. Shown to storefronts as an error code. */
  code: string;
  /** Human-readable, safe to show to a shopper. */
  message: string;
}

export interface InterceptResult<H extends HookName> {
  modify?: HookMap[H]['modify'];
  veto?: Veto;
}

export interface InterceptorDefinition<H extends HookName = HookName, C = unknown> {
  hook: H;
  /** Unique within the extension. */
  name: string;
  /** Lower runs first. Ties break by extension load order, then name. Default 100. */
  order?: number;
  /** Own timeout in ms; capped by the extension's `performance.budgetMs`. */
  timeoutMs?: number;
  /**
   * What happens when this interceptor throws, times out, or is bypassed by its circuit breaker:
   * `open` lets the request continue; `closed` vetoes it. Choose deliberately: `closed` makes the extension
   * a hard dependency of checkout.
   */
  failPolicy: 'open' | 'closed';
  handler(
    payload: Readonly<HookMap[H]['payload']>,
    ctx: C,
  ): InterceptResult<H> | void | Promise<InterceptResult<H> | void>;
}

/** Hooks that sit on the cart/checkout hot path. Interceptors on these require `performance.hotPath: true`. */
export const hotPathHooks: readonly HookName[] = ['cart.item.adding', 'checkout.placing'];
