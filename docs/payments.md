# Payments and multi-currency

`packages/payments` holds the gateway abstraction, payment orchestration, adapters and FX. It depends on `@sold/commerce` (an
order becomes `paid` through `OrderService.transition`) and never the other way round.

## Gateways

```ts
interface PaymentGateway {
  id;
  displayName;
  supportsCurrency(currency): boolean;
  createPayment(req): Promise<{ gatewayRef; status; clientSecret?; redirectUrl?; instructions? }>;
  refund(req): Promise<{ refundRef; status: 'succeeded' | 'pending' | 'failed' }>;
  parseWebhook(rawBody, headers): GatewayEvent[]; // verifies authenticity, then normalises
}
```

Nothing outside an adapter imports a vendor SDK or knows a vendor's event names. Adapters translate into six normalised events
(`payment.requires_action | authorized | captured | failed | voided`, `refund.succeeded | failed`).

| Adapter                                           | Status                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ManualGateway` (bank transfer, cash on delivery) | Complete. An admin confirms receipt (`confirmManually`). Zero-config default.                                                                                                                                                                                                                                                                    |
| `MockGateway` (`@sold/payments/testing`)          | Deterministic, idempotent, signed webhooks. Tests and local dev.                                                                                                                                                                                                                                                                                 |
| `StripeGateway`                                   | Built from Stripe's documented API over plain `fetch`. **Tested only against a local fake API and synthetic fixtures signed with the documented scheme, never against Stripe itself** (no credentials here). Before going live, run it against a Stripe test-mode account and confirm the event names listed at the top of `gateways/stripe.ts`. |

## Rules that keep money correct

1. **Gateway calls happen outside database transactions** and always carry an idempotency key derived from our own ids (the payment id,
   the refund id). A retry after a timeout cannot double-charge or double-refund. A slow gateway never holds a connection or a lock.
2. **Webhooks are stored once** per `(gateway, event_id)` in `payment_events` (the dedupe key and the audit log), applied under the
   payment row lock, and safe to receive twice, out of order, or before we have recorded the gateway reference (they are _deferred_
   and re-applied by `reprocessPending`). Verified: 20 concurrent identical deliveries apply exactly once.
3. **The gateway is the source of truth for status, but never for amounts.** A captured amount that differs from the payment is not
   marked paid: it raises `payment.amount_mismatch` and the event is flagged `needs_attention`.
4. **Money only moves forward.** The database CHECKs refuse `captured > amount` and `refunded > captured`, so a bug cannot over-refund.
   Concurrent refunds are limited by `captured − refunded − pending`, computed under the payment row lock.
5. **Orphans are refunded.** Money that arrives for an order already cancelled (payment window lapsed) is refunded by `reconcileOrphans`
   (idempotent, safe on a schedule) and announced with `payment.orphaned_capture`.
6. **Refunds made in the gateway dashboard are recorded** so our books match theirs.
7. **Client secrets are never stored or logged.**

`orders` move to `paid` only when a matching capture is applied, and to `refunded` only when the payment is fully refunded.

## Webhook endpoint requirements (operator checklist)

- Read the **raw** body (signatures cover the exact bytes; never re-serialise).
- Return `400` for a failed signature, `200` once the event is stored (even if deferred), `5xx` only for transient failures so the gateway retries.
- Run `reprocessPending` and `reconcileOrphans` on a schedule (worker), and alert on `payment_events` rows with `processed_at IS NULL` older than a few minutes.

## Multi-currency

- Base currency prices are authoritative. `FxService.refresh` ingests rates into an **append-only history** (`fx_rates`, exact rationals) with a
  bad-feed guard (rejects a rate that moved more than 20% by default; the previous rate stays in force) and refuses conversion with a
  **stale** rate (default 48 h) instead of guessing.
- `deriveAll` **materialises** prices for the other enabled currencies into `variant_prices`, so the storefront never converts or calls a feed
  on a request path. Only rows marked `derived` are written (a price an operator set by hand is never overwritten), and unchanged rows are not rewritten.
- Rounding rules: `none`, `.99`-style endings (nearest such price, ties up), `ending:E/M` (e.g. JPY `ending:9/10`), `step:N` (cash rounding).
- Historical reporting can reproduce any past conversion with `convert(..., { at })`.
- `HttpFxProvider` expects a `{ rates: { USD: 0.65 } }` feed (the shape of common free feeds). The endpoint is configuration and was **not** verified from this environment.
- A gateway declares the currencies it settles; an order in another currency is refused before any call is made. There is no silent cross-currency settlement.

## Known gaps

- Only automatic-capture card flows are modelled (authorize-then-capture later, partial captures, disputes/chargebacks and payouts reconciliation are not).
- No stored payment methods / customer vaulting, no 3DS-specific handling beyond `requires_action`.
- No gateway settlement-currency conversion: multi-currency relies on the gateway accepting the presentment currency.
- Tax and shipping are not converted by FX; they are computed in the order currency by their own tables.
