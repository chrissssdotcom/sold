import { Money } from '@sold/core';
import { schema, sql } from '@sold/db';
import { ConflictError, ValidationError, VetoError } from '../errors';
import type { CartService } from '../cart';
import type { HookRunner } from '../hooks';
import { noHooks } from '../hooks';
import { lookupIdempotent, runIdempotent } from '../idempotency';
import type { InventoryService } from '../inventory';
import { stockOwnerForCart } from '../orders';
import { writeOutbox } from '../outbox';
import type { DbOrTx, Tx } from '../types';
import type { CheckoutConfig } from './config';
import { placeOrderInput, type PlaceOrderInput } from './input';
import type { Quote, QuoteService } from './quote';

const { orders, orderLines, orderStatusHistory, promotionRedemptions } = schema;

export interface PlacedOrder {
  orderId: string;
  number: string;
  status: 'pending_payment';
  currency: string;
  total: Money;
  /** Stock is held until this time; pay before it or the order is cancelled and the stock released. */
  payBy: Date;
}

/** What is persisted for idempotent replay: plain JSON-safe values only (Money is rebuilt on the way out). */
interface StoredPlacedOrder {
  orderId: string;
  number: string;
  currency: string;
  totalMinor: bigint;
  payBy: Date;
}

const toPlaced = (s: StoredPlacedOrder): PlacedOrder => ({
  orderId: s.orderId,
  number: s.number,
  status: 'pending_payment',
  currency: s.currency,
  total: Money.of(s.totalMinor, s.currency),
  payBy: s.payBy,
});

export interface CheckoutServiceOptions {
  quotes: QuoteService;
  carts: CartService;
  inventory: InventoryService;
  config: CheckoutConfig;
  hooks?: HookRunner;
}

/**
 * Turns a cart into an order. The order is created `pending_payment`, its stock is held, and the cart is closed, all in ONE
 * transaction together with the outbox event and the idempotency record, so a crash at any point leaves either
 * nothing or everything. Retrying with the same idempotency key returns the same order.
 *
 * Price safety: the quote is computed before the transaction (so extension hooks see the real total without a
 * lock held) and again inside it under the cart lock. If the two differ (a price or promotion changed between the
 * shopper's review and the click) nothing is written and the shopper must confirm the new total.
 */
export class CheckoutService {
  private readonly hooks: HookRunner;

  constructor(private readonly opts: CheckoutServiceOptions) {
    this.hooks = opts.hooks ?? noHooks;
  }

  async place(
    db: DbOrTx,
    rawInput: PlaceOrderInput,
    idempotencyKey: string,
  ): Promise<{ order: PlacedOrder; replayed: boolean }> {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey))
      throw new ValidationError('Idempotency-Key must be 8-128 URL-safe characters');
    const input = placeOrderInput.parse(rawInput);
    const request = { ...input, billingAddress: input.billingAddress ?? input.shippingAddress };

    // Cheap replay path: a retry never re-runs pricing or extension hooks.
    const replay = await lookupIdempotent<StoredPlacedOrder>(
      db,
      'checkout',
      idempotencyKey,
      request,
    );
    if (replay) return { order: toPlaced(replay), replayed: true };

    const preQuote = await this.opts.quotes.quote(db, this.quoteRequest(input));
    const decision = await this.hooks.run('checkout.placing', {
      cartId: input.cartId,
      customerId: input.customerId,
      total: { amount: preQuote.total.amount, currency: preQuote.total.currency },
      itemCount: preQuote.lines.reduce((n, l) => n + l.quantity, 0),
    });
    if (decision.veto) throw new VetoError(decision.veto.code, decision.veto.message);

    const result = await runIdempotent(db, 'checkout', idempotencyKey, request, (tx) =>
      this.placeInTransaction(tx, input, request.billingAddress, preQuote),
    );
    return { order: toPlaced(result.value), replayed: result.replayed };
  }

  private quoteRequest(input: ReturnType<typeof placeOrderInput.parse>) {
    return {
      cartId: input.cartId,
      destination: input.shippingAddress,
      shippingMethodId: input.shippingMethodId,
      customerTaxExempt: input.customerTaxExempt,
    };
  }

  private async placeInTransaction(
    tx: Tx,
    input: ReturnType<typeof placeOrderInput.parse>,
    billingAddress: unknown,
    preQuote: Quote,
  ): Promise<StoredPlacedOrder> {
    const cart = await this.opts.carts.lockOpen(tx, input.cartId);
    const quote = await this.opts.quotes.quote(tx, this.quoteRequest(input), cart);
    if (!quote.total.equals(preQuote.total) || quote.cartVersion !== preQuote.cartVersion)
      throw new ConflictError(
        'quote_changed',
        'The price or cart changed; please review and confirm again',
        {
          previous: preQuote.total.toJSON(),
          current: quote.total.toJSON(),
        },
      );
    if (!quote.shipping) throw new ValidationError('Choose a shipping method');
    const customerKey = input.customerId ?? `email:${input.email.toLowerCase()}`;
    const payBy = new Date(Date.now() + this.opts.config.paymentWindowMinutes * 60_000);

    // 1. Stock. All-or-nothing; variants locked in a fixed order by the inventory service.
    await this.opts.inventory.reserveMany(
      tx,
      stockOwnerForCart(cart.id),
      quote.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
      this.opts.config.paymentWindowMinutes * 60,
    );

    // 2. Promotion limits, enforced atomically at the point of redemption.
    await this.redeemPromotions(tx, quote, customerKey);

    // 3. The order, its lines and audit trail.
    const [order] = await tx
      .insert(orders)
      .values({
        cartId: cart.id,
        customerId: input.customerId,
        email: input.email.toLowerCase(),
        consent: input.consent,
        currency: quote.currency,
        subtotal: quote.subtotal.amount,
        discountTotal: quote.discountTotal.amount,
        shippingTotal: quote.shippingTotal.amount,
        taxTotal: quote.taxTotal.amount,
        total: quote.total.amount,
        pricing: JSON.parse(
          JSON.stringify(
            {
              pricesIncludeTax: quote.pricesIncludeTax,
              discounts: quote.pricing.discounts.map((d) => ({
                promotionId: d.promotionId,
                name: d.name,
                code: d.code,
                amount: d.amount,
              })),
              taxBreakdown: quote.tax?.breakdown ?? [],
              shipping: quote.shipping && {
                methodId: quote.shipping.methodId,
                label: quote.shipping.label,
                amount: quote.shipping.amount,
              },
            },
            (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
          ),
        ) as Record<string, unknown>,
        shippingAddress: input.shippingAddress,
        billingAddress,
        shippingMethod: quote.shipping.methodId,
      })
      .returning({ id: orders.id, number: orders.number, placedAt: orders.placedAt });
    if (!order) throw new Error('order insert failed');

    const taxByLine = new Map(quote.tax?.lines.map((l) => [l.lineId, l.tax]) ?? []);
    const zero = Money.zero(quote.currency);
    await tx.insert(orderLines).values(
      quote.lines.map((line) => {
        const priced = quote.pricing.lines.find((p) => p.lineId === line.lineId);
        if (!priced) throw new Error('priced line missing');
        const tax = taxByLine.get(line.lineId) ?? zero;
        return {
          orderId: order.id,
          variantId: line.variantId,
          sku: line.sku,
          title: line.title,
          quantity: line.quantity,
          unitPrice: line.unitPrice.amount,
          discount: priced.discount.amount,
          tax: tax.amount,
          lineTotal: (quote.pricesIncludeTax ? priced.net : priced.net.add(tax)).amount,
        };
      }),
    );
    await tx.insert(orderStatusHistory).values({
      orderId: order.id,
      fromStatus: null,
      toStatus: 'pending_payment',
      actor: input.customerId ? `customer:${input.customerId}` : 'guest',
      reason: 'placed',
    });
    await this.recordRedemptions(tx, quote, order.id, customerKey);
    await this.opts.carts.markConverted(tx, cart.id);

    // 4. The fact, in the same transaction.
    await writeOutbox(tx, {
      aggregateType: 'order',
      aggregateId: order.id,
      eventType: 'order.placed',
      payload: {
        orderId: order.id,
        orderNumber: order.number.toString(),
        customerId: input.customerId,
        total: { amount: quote.total.amount, currency: quote.currency },
        placedAt: order.placedAt,
        marketingConsent: input.consent.marketing,
      },
    });

    return {
      orderId: order.id,
      number: order.number.toString(),
      currency: quote.currency,
      totalMinor: quote.total.amount,
      payBy,
    };
  }

  /** Increment usage counters with a conditional UPDATE and enforce per-customer limits under an advisory lock. */
  private async redeemPromotions(tx: Tx, quote: Quote, customerKey: string): Promise<void> {
    // Fixed order: concurrent orders using the same promotions cannot deadlock.
    const applied = [...quote.pricing.discounts].sort((a, b) =>
      a.promotionId.localeCompare(b.promotionId),
    );
    for (const d of applied) {
      if (d.usage.perCustomerLimit !== null) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`promo:${d.promotionId}:${customerKey}`}, 0))`,
        );
        const used = (
          await tx.execute<{ n: string }>(sql`
            SELECT count(*) AS n FROM promotion_redemptions
            WHERE promotion_id = ${d.promotionId} AND customer_key = ${customerKey}`)
        ).rows[0];
        if (Number(used?.n ?? 0) >= d.usage.perCustomerLimit)
          throw new ConflictError('promotion_limit_reached', 'You have already used this offer', {
            promotionId: d.promotionId,
          });
      }
      const res = await tx.execute(sql`
        UPDATE promotions SET usage_count = usage_count + 1
        WHERE id = ${d.promotionId} AND (usage_limit IS NULL OR usage_count < usage_limit)
        RETURNING id`);
      if (res.rows.length === 0)
        throw new ConflictError('promotion_exhausted', 'This offer is no longer available', {
          promotionId: d.promotionId,
        });
    }
  }

  private async recordRedemptions(
    tx: Tx,
    quote: Quote,
    orderId: string,
    customerKey: string,
  ): Promise<void> {
    if (quote.pricing.discounts.length === 0) return;
    await tx.insert(promotionRedemptions).values(
      quote.pricing.discounts.map((d) => ({
        promotionId: d.promotionId,
        orderId,
        customerKey,
        amount: d.amount.amount,
      })),
    );
  }
}
