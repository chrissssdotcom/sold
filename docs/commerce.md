# Commerce core

`packages/commerce` is the domain layer: catalog, inventory, cart, pricing, promotions, tax, shipping, checkout and orders.
It has no HTTP and no framework code; `apps/web` and the worker call it. All state lives in PostgreSQL, so every process
is stateless and can be scaled horizontally.

```
createCommerce({ hooks, pricing?, tax?, shipping?, inventoryStrategy?, checkout? })
  ├─ catalog     products, variants, per-currency prices, keyset-paginated listing (replica reads)
  ├─ inventory   reservations behind an `InventoryReservationStrategy`
  ├─ carts       row-locked mutations, optimistic version, coupons, guest→customer merge
  ├─ promotions  admin + candidate lookup; engine lives in ./pricing
  ├─ quotes      cart → list prices → promotions → shipping → tax → total
  ├─ checkout    quote, verify, then one transaction that creates the order
  └─ orders      state machine + stock side effects + outbox events
```

## Money

`Money` (`@sold/core`) is bigint minor units plus an ISO-4217 code. There are no floats anywhere. Every operation that can
produce a fraction takes an explicit rounding mode. Cross-currency arithmetic throws. The database mirrors this: money columns are
`bigint`, and `CHECK` constraints reject negative amounts.

## Checkout is one transaction

`CheckoutService.place` is the only way an order is created:

1. Replay check: a retry with a stored idempotency key returns the stored order without re-pricing or running hooks.
2. Quote outside the transaction (no lock held), then run the `checkout.placing` interceptors with the real total.
   A veto stops here; nothing has been written.
3. One transaction (`runIdempotent`), under the cart row lock:
   - re-quote and compare with step 2; a moved price or changed cart → `quote_changed`, nothing written;
   - reserve stock for every line (all-or-nothing, variants locked in a fixed order);
   - redeem promotions (conditional `UPDATE … WHERE usage_count < usage_limit`; per-customer limits under an advisory lock);
   - insert the order, its lines (price/discount/tax snapshotted) and its status history;
   - close the cart, write the `order.placed` outbox event, store the idempotency response.

A crash at any point leaves either nothing or everything. `orders.cart_id` is `UNIQUE`, so even a bug cannot convert one cart
twice.

Verified by `checkout.int.test.ts` (real PostgreSQL): 300 shoppers racing for 20 units place exactly 20 orders and the 280
losers leave no orders, no holds and still-open carts; 20 concurrent retries with one key make one order; a promotion with a
usage limit of 1 redeemed by two concurrent orders succeeds once.

## Inventory

`available = on_hand − reserved`. A hold is one atomic conditional statement:

```sql
UPDATE inventory_levels SET reserved = reserved + $q
WHERE variant_id = $v AND (allow_backorder OR on_hand - reserved >= $q)
```

The row lock serialises contenders and the predicate is re-checked after the lock, so two buyers can never both take the last
unit. `CHECK (reserved <= on_hand)` is a second line of defence: a bug in application code makes the database refuse the write
(tested by writing around the application).

Holds are idempotent per `(owner, variant)`, expire (`sweepExpired`, bounded batches, `SKIP LOCKED`), and are committed into a
permanent decrement inside the order-payment transaction.

| Strategy | Use | Behaviour |
| --- | --- | --- |
| `PostgresReservationStrategy` (default) | everything | authoritative, always correct |
| `GatedReservationStrategy` + `InventoryGate` | hot SKUs during drops | Redis counter rejects "sold out" in microseconds so the losers never reach the database row |

The gate is an optimisation, never the source of truth. It can be stale-high (harmless: Postgres refuses) or stale-low (shoppers
see "sold out" early for at most `counterTtlSeconds`, default 30, then the counter is re-derived). Redis down or slow → fail open
to Postgres behind a circuit breaker. So it can reject wrongly for a short while but can never cause an oversell.

Measured locally (single machine, PostgreSQL 16, pool of 20, in-flight cap 64; **not** a capacity claim, see `docs/scaling.md`):
5,000 buyers for 100 units sells exactly 100 in ~2.2 s on the Postgres strategy; with the gate ~0.4 s and only 100 requests reach Postgres.

Stock is only checked softly when adding to a cart and *held* at checkout, so abandoned carts cannot lock up a limited drop.

Unpaid orders hold stock for `paymentWindowMinutes` (default 30); `OrderService.cancelUnpaid` and `InventoryService.sweepExpired`
are the sweeps the worker runs. If payment lands after the hold lapsed, the order re-secures stock; if it cannot, the order
still moves to `paid` (the money is real) with `stockShortfall: true` and an `order.attention_required` event for a human. It is
never a silent oversell and never a lost payment.

## Orders

```
pending_payment → paid | cancelled
paid            → processing | cancelled | refunded
processing      → shipped | cancelled | refunded
shipped         → delivered | refunded
delivered       → refunded          cancelled, refunded: terminal
```

`OrderService.transition` locks the order row, so a payment webhook racing an admin action serialises and the loser gets
`illegal_transition`. Stock effects and the `order.status_changed` outbox event commit with the status change.

## Events: transactional outbox

Facts (`order.placed`, `order.status_changed`, …) are written to `outbox_events` in the same transaction as the change.
`relayOutbox` publishes committed rows to the extension `EventBus`: `FOR UPDATE SKIP LOCKED` (many relays in parallel), exponential
backoff on failure, **at-least-once** delivery with a stable `eventId`. Consumers must be idempotent; ordering across
aggregates is not guaranteed.

## Pricing, tax, shipping

Pure, deterministic engines (no I/O; explicit `now`), so checkout can recompute and snapshot. Each sits behind a provider interface that an
extension can replace through the service registry. Property-tested with seeded PRNGs (per-line discounts sum exactly to the
total; net + tax = gross; parts sum to the whole; results are independent of input order).

- **Promotions**: percent-off, fixed-off, buy-X-get-Y, free-shipping; stacking, exclusive groups, priorities, windows, minimum spend.
  Rules are documented at the top of `pricing/engine.ts`.
- **Tax**: table-driven, inclusive or exclusive pricing, multi-component rates, per-line half-up rounding. **The bundled tables
  are illustrative, not tax advice**; a real deployment supplies its own table or a provider extension. Rates are integer basis
  points, so a rate such as 9.975% cannot be expressed yet.
- **Shipping**: zones (most specific wins), flat / per-item / weight-table / free-over methods, per-currency prices, never converts
  silently. An empty quote means "cannot ship there" and checkout refuses.

## Known gaps (Phase 2)

- Payments (Phase 3): orders stop at `pending_payment`; nothing captures money yet.
- No HTTP surface yet for the storefront; wiring into `apps/web` routes with traffic classes is the next step.
- Tax rates in basis points only; no tax-provider caching layer (a third-party provider must not be called synchronously on the checkout path).
- Guest order lookup, returns/RMA, partial shipments and partial refunds are not modelled.
- Inventory is one location per variant.
