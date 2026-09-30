import { and, desc, eq, schema, sql, type PrimaryDb, type ReplicaDb } from '@sold/db';
import { Money } from '@sold/core';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import type { InventoryService } from '../inventory';
import { writeOutbox } from '../outbox';
import type { DbOrTx, Tx } from '../types';
import { assertTransition, type OrderStatus } from './state-machine';

const { orders, orderLines, orderStatusHistory } = schema;

export interface OrderLineView {
  id: string;
  variantId: string | null;
  sku: string;
  title: string;
  quantity: number;
  unitPrice: Money;
  discount: Money;
  tax: Money;
  lineTotal: Money;
}

export interface OrderView {
  id: string;
  number: string;
  cartId: string | null;
  customerId: string | null;
  email: string;
  status: OrderStatus;
  currency: string;
  subtotal: Money;
  discountTotal: Money;
  shippingTotal: Money;
  taxTotal: Money;
  total: Money;
  shippingAddress: unknown;
  billingAddress: unknown;
  shippingMethod: string | null;
  placedAt: Date;
  lines: OrderLineView[];
}

export interface TransitionOptions {
  actor: string;
  reason?: string;
}

/** Owner ref used for the stock hold of an order's cart. One place, so reserve/commit/release always agree. */
export const stockOwnerForCart = (cartId: string): string => `cart:${cartId}`;

export class OrderService {
  constructor(private readonly inventory: InventoryService) {}

  async get(db: PrimaryDb | ReplicaDb, orderId: string): Promise<OrderView> {
    return this.load(db, eq(orders.id, orderId), orderId);
  }

  async getByNumber(db: PrimaryDb | ReplicaDb, number: string): Promise<OrderView> {
    if (!/^\d{1,18}$/.test(number)) throw new NotFoundError('Order', number);
    return this.load(db, eq(orders.number, BigInt(number)), number);
  }

  private async load(
    db: PrimaryDb | ReplicaDb,
    where: ReturnType<typeof eq>,
    ref: string,
  ): Promise<OrderView> {
    const [o] = await db.select().from(orders).where(where).limit(1);
    if (!o) throw new NotFoundError('Order', ref);
    const lines = await db.select().from(orderLines).where(eq(orderLines.orderId, o.id));
    const currency = o.currency.trim();
    const m = (v: bigint) => Money.of(v, currency);
    return {
      id: o.id,
      number: o.number.toString(),
      cartId: o.cartId,
      customerId: o.customerId,
      email: o.email,
      status: o.status as OrderStatus,
      currency,
      subtotal: m(o.subtotal),
      discountTotal: m(o.discountTotal),
      shippingTotal: m(o.shippingTotal),
      taxTotal: m(o.taxTotal),
      total: m(o.total),
      shippingAddress: o.shippingAddress,
      billingAddress: o.billingAddress,
      shippingMethod: o.shippingMethod,
      placedAt: o.placedAt,
      lines: lines.map((l) => ({
        id: l.id,
        variantId: l.variantId,
        sku: l.sku,
        title: l.title,
        quantity: l.quantity,
        unitPrice: m(l.unitPrice),
        discount: m(l.discount),
        tax: m(l.tax),
        lineTotal: m(l.lineTotal),
      })),
    };
  }

  /** A customer's orders, newest first, keyset-paginated. */
  async listForCustomer(
    db: PrimaryDb | ReplicaDb,
    customerId: string,
    opts: { limit?: number; before?: { placedAt: Date; id: string } } = {},
  ): Promise<{ id: string; number: string; status: OrderStatus; total: Money; placedAt: Date }[]> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const rows = await db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.customerId, customerId),
          opts.before
            ? sql`(${orders.placedAt}, ${orders.id}) < (${opts.before.placedAt}, ${opts.before.id})`
            : sql`true`,
        ),
      )
      .orderBy(desc(orders.placedAt), desc(orders.id))
      .limit(limit);
    return rows.map((o) => ({
      id: o.id,
      number: o.number.toString(),
      status: o.status as OrderStatus,
      total: Money.of(o.total, o.currency.trim()),
      placedAt: o.placedAt,
    }));
  }

  /**
   * Move an order along the state machine. Locks the order row, so two workers racing (a payment webhook
   * and an admin cancel) serialise and the loser gets `illegal_transition` instead of corrupting state.
   * Side effects on stock and the outbox event commit atomically with the status change.
   */
  async transition(
    db: DbOrTx,
    orderId: string,
    to: OrderStatus,
    opts: TransitionOptions,
  ): Promise<{ from: OrderStatus; to: OrderStatus; stockShortfall: boolean }> {
    return db.transaction(async (tx) => {
      const locked = await tx.execute<{
        status: OrderStatus;
        cart_id: string | null;
        currency: string;
        total: bigint;
        customer_id: string | null;
      }>(
        sql`SELECT status, cart_id, currency, total, customer_id FROM orders WHERE id = ${orderId} FOR UPDATE`,
      );
      const row = locked.rows[0];
      if (!row) throw new NotFoundError('Order', orderId);
      const from = row.status;
      assertTransition(from, to);
      let stockShortfall = false;

      if (to === 'paid' && row.cart_id)
        stockShortfall = await this.commitStock(tx, orderId, row.cart_id);
      if (to === 'cancelled' || to === 'refunded')
        await this.returnStock(tx, orderId, from, row.cart_id);

      await tx.update(orders).set({ status: to }).where(eq(orders.id, orderId));
      await tx.insert(orderStatusHistory).values({
        orderId,
        fromStatus: from,
        toStatus: to,
        actor: opts.actor,
        reason: opts.reason ?? (stockShortfall ? 'stock_unavailable_after_payment' : ''),
      });
      await writeOutbox(tx, {
        aggregateType: 'order',
        aggregateId: orderId,
        eventType: 'order.status_changed',
        payload: { orderId, from, to, actor: opts.actor, stockShortfall },
      });
      return { from, to, stockShortfall };
    });
  }

  /**
   * Turn the checkout hold into a permanent decrement. If the hold lapsed before payment landed, re-secure the stock;
   * if that is impossible the order still moves to paid (the money is real) but is flagged for a human: never a
   * silent oversell, never a lost payment.
   */
  private async commitStock(tx: Tx, orderId: string, cartId: string): Promise<boolean> {
    const owner = stockOwnerForCart(cartId);
    const committed = await this.inventory.commit(tx, owner);
    if (committed.length > 0) return false;
    const lines = await tx
      .select({ variantId: orderLines.variantId, quantity: orderLines.quantity })
      .from(orderLines)
      .where(eq(orderLines.orderId, orderId));
    const wanted = lines.filter(
      (l): l is { variantId: string; quantity: number } => l.variantId !== null,
    );
    try {
      await this.inventory.reserveMany(tx, owner, wanted, 60);
      await this.inventory.commit(tx, owner);
      return false;
    } catch (error) {
      if (error instanceof ConflictError) {
        await writeOutbox(tx, {
          aggregateType: 'order',
          aggregateId: orderId,
          eventType: 'order.attention_required',
          payload: { orderId, reason: 'stock_unavailable_after_payment' },
        });
        return true;
      }
      throw error;
    }
  }

  private async returnStock(
    tx: Tx,
    orderId: string,
    from: OrderStatus,
    cartId: string | null,
  ): Promise<void> {
    if (from === 'pending_payment') {
      if (cartId) await this.inventory.release(tx, stockOwnerForCart(cartId));
      return;
    }
    // Shipped goods are physically gone: a refund of shipped/delivered stock is restocked only by an explicit return.
    if (from === 'paid' || from === 'processing') {
      const lines = await tx
        .select({ variantId: orderLines.variantId, quantity: orderLines.quantity })
        .from(orderLines)
        .where(eq(orderLines.orderId, orderId));
      for (const l of lines)
        if (l.variantId) await this.inventory.restock(tx, l.variantId, l.quantity);
    }
  }

  /** Cancel orders that never got paid within `olderThanMinutes`, releasing their stock. Bounded batch. */
  async cancelUnpaid(
    db: PrimaryDb,
    olderThanMinutes: number,
    opts: { limit?: number } = {},
  ): Promise<number> {
    if (olderThanMinutes < 1) throw new ValidationError('olderThanMinutes must be >= 1');
    const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
    const stale = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.status, 'pending_payment'), sql`${orders.placedAt} < ${cutoff}`))
      .orderBy(orders.placedAt)
      .limit(opts.limit ?? 200);
    let cancelled = 0;
    for (const { id } of stale) {
      try {
        await this.transition(db, id, 'cancelled', { actor: 'system', reason: 'payment_timeout' });
        cancelled++;
      } catch (error) {
        // Paid (or cancelled) between the scan and the lock: nothing to do.
        if (!(error instanceof ConflictError)) throw error;
      }
    }
    return cancelled;
  }
}
