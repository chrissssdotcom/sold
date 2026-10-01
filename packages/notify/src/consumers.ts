import type { OrderService } from '@sold/commerce';
import { eq, inArray, schema, type PrimaryDb } from '@sold/db';
import type { NotificationService } from './service';

export interface OutboxEventLike {
  eventId: string;
  eventType: string;
  payload: unknown;
}

export interface ConsumerDeps {
  db: PrimaryDb;
  notify: NotificationService;
  orders: OrderService;
  /** Absolute link a customer can open to see this order (signed: guests have no account). */
  orderUrl(orderId: string): string;
  /** Absolute storefront URL for a product handle (review requests link to the product page). */
  productUrl(handle: string): string;
  /** Ask for a review this many days after delivery. 0 or absent: never. */
  reviewRequestDays?: number;
}

const wire = (m: {
  amount: bigint;
  currency: string;
  toJSON(): { amount: string; currency: string };
}) => m.toJSON();

/**
 * Turn domain events into emails. Runs inside the at-least-once outbox relay, so it must be idempotent: the dedupe key
 * is `<event id>:<template>`, and a redelivered event queues nothing new. Reads the order fresh rather than trusting the
 * event payload, so the email reflects the order as it is now.
 *
 * Returns true if this event is one we handle (whether or not an email was newly queued).
 */
export async function notifyOnEvent(deps: ConsumerDeps, e: OutboxEventLike): Promise<boolean> {
  const p = e.payload as Record<string, unknown>;
  const orderId = typeof p['orderId'] === 'string' ? p['orderId'] : null;
  if (!orderId) return false;

  if (e.eventType === 'order.placed') {
    const o = await deps.orders.get(deps.db, orderId);
    await deps.notify.enqueue(deps.db, {
      dedupeKey: `${e.eventId}:order-confirmation`,
      template: 'order-confirmation',
      to: o.email,
      data: {
        orderNumber: o.number,
        orderUrl: deps.orderUrl(orderId),
        lines: o.lines.map((l) => ({
          title: l.title,
          quantity: l.quantity,
          total: wire(l.lineTotal),
        })),
        total: wire(o.total),
        pendingPayment: o.status === 'pending_payment',
      },
    });
    return true;
  }

  if (e.eventType === 'order.status_changed') {
    const to = String(p['to']);
    const template =
      to === 'shipped' ? 'order-shipped' : to === 'cancelled' ? 'order-cancelled' : null;
    if (to === 'delivered') {
      // Optional follow-up: a review request, delayed. Off unless the operator set `notifications.reviewRequestDays`.
      const days = deps.reviewRequestDays ?? 0;
      if (days <= 0) return false;
      const o = await deps.orders.get(deps.db, orderId);
      const variantIds = o.lines.map((l) => l.variantId).filter((v): v is string => v !== null);
      if (variantIds.length === 0) return false;
      const rows = await deps.db
        .selectDistinct({ handle: schema.products.handle, title: schema.products.title })
        .from(schema.productVariants)
        .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
        .where(inArray(schema.productVariants.id, variantIds))
        .limit(20);
      if (rows.length === 0) return false;
      await deps.notify.enqueue(deps.db, {
        dedupeKey: `${e.eventId}:review-request`,
        template: 'review-request',
        to: o.email,
        delaySeconds: days * 86_400,
        data: {
          orderNumber: o.number,
          items: rows.map((r) => ({ title: r.title, url: deps.productUrl(r.handle) })),
        },
      });
      return true;
    }
    if (to === 'refunded') {
      const o = await deps.orders.get(deps.db, orderId);
      await deps.notify.enqueue(deps.db, {
        dedupeKey: `${e.eventId}:order-refunded`,
        template: 'order-refunded',
        to: o.email,
        data: { orderNumber: o.number, orderUrl: deps.orderUrl(orderId), amount: wire(o.total) },
      });
      return true;
    }
    if (!template) return false;
    const o = await deps.orders.get(deps.db, orderId);
    await deps.notify.enqueue(deps.db, {
      dedupeKey: `${e.eventId}:${template}`,
      template,
      to: o.email,
      data: { orderNumber: o.number, orderUrl: deps.orderUrl(orderId) },
    });
    return true;
  }
  return false;
}
