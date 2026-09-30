import { Money, fromJsonSafe, toJsonSafe, type JsonSafe } from '@sold/core';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  writeOutbox,
  type OrderService,
  type Tx,
} from '@sold/commerce';
import { sql, type PrimaryDb } from '@sold/db';
import {
  GatewayError,
  type GatewayEvent,
  type PaymentGateway,
  type PaymentStatus,
} from './gateway';
import { GatewayUnavailableError, PaymentInProgressError } from './errors';
import { canMovePayment, openPaymentStatuses } from './status';

export interface PaymentServiceOptions {
  gateways: readonly PaymentGateway[];
  orders: OrderService;
}

export interface StartPaymentInput {
  orderId: string;
  gatewayId: string;
  returnUrl?: string;
}

export interface StartedPayment {
  paymentId: string;
  gatewayId: string;
  status: PaymentStatus;
  clientSecret?: string;
  redirectUrl?: string;
  instructions?: string;
}

export type ApplyOutcome = 'applied' | 'ignored' | 'deferred' | 'needs_attention';

export interface WebhookSummary {
  received: number;
  applied: number;
  duplicates: number;
  deferred: number;
  needsAttention: number;
}

interface PaymentRow extends Record<string, unknown> {
  id: string;
  order_id: string;
  gateway: string;
  gateway_ref: string | null;
  status: PaymentStatus;
  currency: string;
  amount: string;
  captured: string;
  refunded: string;
}

export interface RefundInput {
  paymentId: string;
  amount: Money;
  reason: string;
  actor: string;
  idempotencyKey: string;
}

export interface RefundRecord {
  id: string;
  paymentId: string;
  amount: Money;
  status: 'pending' | 'succeeded' | 'failed';
}

/**
 * Payment orchestration. The rules that keep money correct:
 *  - Calls to a gateway happen OUTSIDE database transactions (a slow gateway must never hold a connection or a lock)
 *    and always carry an idempotency key derived from OUR ids, so a retry can never double-charge or double-refund.
 *  - Webhooks are stored once per (gateway, event id) before they are applied, applied under the payment row lock, and
 *    are safe to receive twice, out of order, or before we know the gateway's reference (they are deferred and retried).
 *  - Money moves only forward: the payments table CHECKs refuse captured > amount and refunded > captured.
 */
export class PaymentService {
  private readonly gateways: Map<string, PaymentGateway>;
  private readonly orders: OrderService;

  constructor(opts: PaymentServiceOptions) {
    this.gateways = new Map(opts.gateways.map((g) => [g.id, g]));
    this.orders = opts.orders;
  }

  gateway(id: string): PaymentGateway {
    const g = this.gateways.get(id);
    if (!g) throw new GatewayUnavailableError(id);
    return g;
  }

  listGateways(currency: string): { id: string; displayName: string }[] {
    return [...this.gateways.values()]
      .filter((g) => g.supportsCurrency(currency))
      .map((g) => ({ id: g.id, displayName: g.displayName }));
  }

  // ---------------------------------------------------------------------------------------------------------
  // Starting a payment
  // ---------------------------------------------------------------------------------------------------------

  async start(db: PrimaryDb, input: StartPaymentInput): Promise<StartedPayment> {
    const gateway = this.gateway(input.gatewayId);
    const prepared = await db.transaction(async (tx) => {
      const order = (
        await tx.execute<{
          id: string;
          number: string;
          status: string;
          currency: string;
          total: string;
          email: string;
        }>(sql`SELECT id, number::text AS number, status, currency, total::text AS total, email
               FROM orders WHERE id = ${input.orderId} FOR UPDATE`)
      ).rows[0];
      if (!order) throw new NotFoundError('Order', input.orderId);
      if (order.status !== 'pending_payment')
        throw new ConflictError('order_not_payable', 'This order can no longer be paid', {
          status: order.status,
        });
      const currency = order.currency.trim();
      if (!gateway.supportsCurrency(currency))
        throw new ValidationError(`${gateway.displayName} does not accept ${currency}`);
      const open = (
        await tx.execute<{ id: string; gateway: string; status: PaymentStatus }>(sql`
          SELECT id, gateway, status FROM payments
          WHERE order_id = ${order.id} AND status IN (${sql.join(
            openPaymentStatuses.map((s) => sql`${s}`),
            sql`, `,
          )})
          ORDER BY created_at DESC LIMIT 1`)
      ).rows[0];
      if (open && open.gateway !== gateway.id) throw new PaymentInProgressError(order.id);
      const paymentId =
        open?.id ??
        (
          await tx.execute<{ id: string }>(sql`
            INSERT INTO payments (order_id, gateway, currency, amount)
            VALUES (${order.id}, ${gateway.id}, ${currency}, ${order.total}::bigint)
            RETURNING id`)
        ).rows[0]!.id;
      return {
        paymentId,
        orderId: order.id,
        orderNumber: order.number,
        email: order.email,
        amount: Money.of(BigInt(order.total), currency),
      };
    });

    let result;
    try {
      // Idempotent by construction: the same paymentId always yields the same gateway payment.
      result = await gateway.createPayment({
        paymentId: prepared.paymentId,
        orderId: prepared.orderId,
        orderNumber: prepared.orderNumber,
        amount: prepared.amount,
        customerEmail: prepared.email,
        ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
      });
    } catch (error) {
      if (error instanceof GatewayError && !error.retryable)
        await db.execute(sql`
          UPDATE payments SET status = 'failed', failure_code = ${error.code ?? 'gateway_error'}
          WHERE id = ${prepared.paymentId} AND status IN ('pending', 'requires_action')`);
      throw error;
    }

    // Record the gateway's answer. Guarded so it can never move a payment backwards past a webhook that won the race.
    await db.execute(sql`
      UPDATE payments
      SET gateway_ref = COALESCE(gateway_ref, ${result.gatewayRef}),
          status = CASE WHEN status IN ('pending', 'requires_action') THEN ${result.status} ELSE status END
      WHERE id = ${prepared.paymentId}`);
    return {
      paymentId: prepared.paymentId,
      gatewayId: gateway.id,
      status: result.status,
      ...(result.clientSecret ? { clientSecret: result.clientSecret } : {}),
      ...(result.redirectUrl ? { redirectUrl: result.redirectUrl } : {}),
      ...(result.instructions ? { instructions: result.instructions } : {}),
    };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Webhooks
  // ---------------------------------------------------------------------------------------------------------

  /** Verify, store once, apply. Throws `WebhookVerificationError` for an inauthentic delivery (respond 400). */
  async handleWebhook(
    db: PrimaryDb,
    gatewayId: string,
    rawBody: string,
    headers: Headers,
  ): Promise<WebhookSummary> {
    const events = this.gateway(gatewayId).parseWebhook(rawBody, headers);
    const summary: WebhookSummary = {
      received: events.length,
      applied: 0,
      duplicates: 0,
      deferred: 0,
      needsAttention: 0,
    };
    for (const event of events) {
      const stored = await db.execute<{ event_id: string }>(sql`
        INSERT INTO payment_events (gateway, event_id, type, payload)
        VALUES (${gatewayId}, ${event.eventId}, ${event.type}, ${JSON.stringify(encodeEvent(event))}::jsonb)
        ON CONFLICT (gateway, event_id) DO NOTHING RETURNING event_id`);
      if (stored.rows.length === 0) {
        const prior = (
          await db.execute<{ processed_at: Date | null }>(sql`
            SELECT processed_at FROM payment_events WHERE gateway = ${gatewayId} AND event_id = ${event.eventId}`)
        ).rows[0];
        if (prior?.processed_at) {
          summary.duplicates++;
          continue;
        }
      }
      await this.processStored(db, gatewayId, event, summary);
    }
    return summary;
  }

  /** Re-apply stored events that could not be applied yet (arrived before the payment reference was recorded). */
  async reprocessPending(
    db: PrimaryDb,
    opts: { olderThanSeconds?: number; limit?: number } = {},
  ): Promise<WebhookSummary> {
    const rows = (
      await db.execute<{ gateway: string; payload: JsonSafe }>(sql`
        SELECT gateway, payload FROM payment_events
        WHERE processed_at IS NULL AND received_at < now() - make_interval(secs => ${opts.olderThanSeconds ?? 5})
        ORDER BY received_at LIMIT ${opts.limit ?? 100}`)
    ).rows;
    const summary: WebhookSummary = {
      received: rows.length,
      applied: 0,
      duplicates: 0,
      deferred: 0,
      needsAttention: 0,
    };
    for (const row of rows)
      await this.processStored(db, row.gateway, decodeEvent(row.payload), summary);
    return summary;
  }

  private async processStored(
    db: PrimaryDb,
    gatewayId: string,
    event: GatewayEvent,
    summary: WebhookSummary,
  ): Promise<void> {
    let outcome: ApplyOutcome;
    let error: string | null = null;
    try {
      outcome = await this.applyEvent(db, gatewayId, event);
    } catch (e) {
      // Transient (deadlock, timeout): leave unprocessed so the gateway's retry or the sweep applies it.
      await db.execute(sql`
        UPDATE payment_events SET error = ${String((e as Error).message).slice(0, 500)}
        WHERE gateway = ${gatewayId} AND event_id = ${event.eventId}`);
      throw e;
    }
    if (outcome === 'deferred') {
      summary.deferred++;
      return;
    }
    if (outcome === 'needs_attention') {
      summary.needsAttention++;
      error = 'needs_attention';
    } else if (outcome === 'applied') summary.applied++;
    await db.execute(sql`
      UPDATE payment_events SET processed_at = now(), error = ${error}
      WHERE gateway = ${gatewayId} AND event_id = ${event.eventId}`);
  }

  async applyEvent(db: PrimaryDb, gatewayId: string, event: GatewayEvent): Promise<ApplyOutcome> {
    return db.transaction(async (tx) => {
      const payment = (
        await tx.execute<PaymentRow>(sql`
          SELECT id, order_id, gateway, gateway_ref, status, currency, amount::text AS amount,
                 captured::text AS captured, refunded::text AS refunded
          FROM payments WHERE gateway = ${gatewayId} AND gateway_ref = ${event.gatewayRef} FOR UPDATE`)
      ).rows[0];
      // The webhook can beat the response that records the reference: retry shortly.
      if (!payment) return 'deferred';
      const currency = payment.currency.trim();

      switch (event.type) {
        case 'payment.requires_action':
          return this.move(tx, payment, 'requires_action');
        case 'payment.authorized':
          return this.move(tx, payment, 'authorized');
        case 'payment.voided':
          return this.move(tx, payment, 'voided');
        case 'payment.failed':
          return this.move(tx, payment, 'failed', event.code);
        case 'payment.captured':
          return this.onCaptured(tx, payment, event.amount);
        case 'refund.succeeded':
          return this.onRefundSucceeded(tx, payment, currency, event.refundRef, event.amount);
        case 'refund.failed':
          await tx.execute(sql`
            UPDATE refunds SET status = 'failed' WHERE payment_id = ${payment.id} AND gateway_ref = ${event.refundRef} AND status = 'pending'`);
          return 'applied';
      }
    });
  }

  private async move(
    tx: Tx,
    payment: PaymentRow,
    to: PaymentStatus,
    failureCode?: string,
  ): Promise<ApplyOutcome> {
    if (payment.status === to) return 'ignored';
    if (!canMovePayment(payment.status, to)) return 'ignored'; // stale or out-of-order: the gateway told us less than we know
    await tx.execute(sql`
      UPDATE payments SET status = ${to}, failure_code = ${failureCode ?? null} WHERE id = ${payment.id}`);
    return 'applied';
  }

  private async onCaptured(tx: Tx, payment: PaymentRow, captured: Money): Promise<ApplyOutcome> {
    const currency = payment.currency.trim();
    if (
      payment.status === 'captured' ||
      payment.status === 'partially_refunded' ||
      payment.status === 'refunded'
    )
      return 'ignored';
    if (!canMovePayment(payment.status, 'captured')) return 'ignored';
    // Never trust a gateway amount blindly: a mismatch is a human's problem, not something to mark paid.
    if (captured.currency !== currency || captured.amount !== BigInt(payment.amount)) {
      await writeOutbox(tx, {
        aggregateType: 'payment',
        aggregateId: payment.id,
        eventType: 'payment.amount_mismatch',
        payload: {
          paymentId: payment.id,
          orderId: payment.order_id,
          expected: { amount: BigInt(payment.amount), currency },
          captured: { amount: captured.amount, currency: captured.currency },
        },
      });
      return 'needs_attention';
    }
    await tx.execute(sql`
      UPDATE payments SET status = 'captured', captured = ${captured.amount}::bigint, failure_code = NULL
      WHERE id = ${payment.id}`);

    const order = (
      await tx.execute<{ status: string }>(
        sql`SELECT status FROM orders WHERE id = ${payment.order_id}`,
      )
    ).rows[0];
    if (order?.status === 'pending_payment') {
      await this.orders.transition(tx, payment.order_id, 'paid', {
        actor: `payment:${payment.gateway}`,
      });
    } else if (order?.status === 'cancelled') {
      // Money arrived for an order that was cancelled (payment window lapsed): refund it, do not keep it.
      await writeOutbox(tx, {
        aggregateType: 'payment',
        aggregateId: payment.id,
        eventType: 'payment.orphaned_capture',
        payload: { paymentId: payment.id, orderId: payment.order_id },
      });
    }
    await writeOutbox(tx, {
      aggregateType: 'payment',
      aggregateId: payment.id,
      eventType: 'payment.captured',
      payload: {
        paymentId: payment.id,
        orderId: payment.order_id,
        amount: { amount: captured.amount, currency },
        gateway: payment.gateway,
      },
    });
    return 'applied';
  }

  // ---------------------------------------------------------------------------------------------------------
  // Refunds
  // ---------------------------------------------------------------------------------------------------------

  async refund(db: PrimaryDb, input: RefundInput): Promise<RefundRecord> {
    const prepared = await db.transaction(async (tx) => {
      const payment = (
        await tx.execute<PaymentRow>(sql`
          SELECT id, order_id, gateway, gateway_ref, status, currency, amount::text AS amount,
                 captured::text AS captured, refunded::text AS refunded
          FROM payments WHERE id = ${input.paymentId} FOR UPDATE`)
      ).rows[0];
      if (!payment) throw new NotFoundError('Payment', input.paymentId);
      const currency = payment.currency.trim();
      if (input.amount.currency !== currency)
        throw new ValidationError('Refund currency must match the payment');
      if (input.amount.amount <= 0n) throw new ValidationError('Refund amount must be positive');

      const existing = (
        await tx.execute<{
          id: string;
          payment_id: string;
          amount: string;
          status: RefundRecord['status'];
        }>(sql`
          SELECT id, payment_id, amount::text AS amount, status FROM refunds WHERE idempotency_key = ${input.idempotencyKey}`)
      ).rows[0];
      if (existing) {
        if (existing.payment_id !== payment.id || BigInt(existing.amount) !== input.amount.amount)
          throw new ConflictError(
            'idempotency_key_reuse',
            'This refund key was used for a different refund',
          );
        return {
          payment,
          refundId: existing.id,
          alreadyDone: existing.status !== 'pending',
          status: existing.status,
        };
      }
      if (payment.status !== 'captured' && payment.status !== 'partially_refunded')
        throw new ConflictError(
          'payment_not_refundable',
          'Only captured payments can be refunded',
          {
            status: payment.status,
          },
        );
      const pending = (
        await tx.execute<{ s: string }>(sql`
          SELECT COALESCE(sum(amount), 0)::text AS s FROM refunds WHERE payment_id = ${payment.id} AND status = 'pending'`)
      ).rows[0]!;
      const available = BigInt(payment.captured) - BigInt(payment.refunded) - BigInt(pending.s);
      if (input.amount.amount > available)
        throw new ValidationError('Refund exceeds the refundable amount', {
          requested: input.amount.amount.toString(),
          available: available.toString(),
        });
      const refundId = (
        await tx.execute<{ id: string }>(sql`
          INSERT INTO refunds (payment_id, amount, currency, reason, actor, idempotency_key)
          VALUES (${payment.id}, ${input.amount.amount}::bigint, ${currency}, ${input.reason}, ${input.actor}, ${input.idempotencyKey})
          RETURNING id`)
      ).rows[0]!.id;
      return { payment, refundId, alreadyDone: false, status: 'pending' as const };
    });

    if (prepared.alreadyDone)
      return {
        id: prepared.refundId,
        paymentId: input.paymentId,
        amount: input.amount,
        status: prepared.status,
      };

    const gateway = this.gateway(prepared.payment.gateway);
    if (!prepared.payment.gateway_ref)
      throw new ConflictError('payment_not_refundable', 'Payment has no gateway reference');
    let result;
    try {
      result = await gateway.refund({
        gatewayRef: prepared.payment.gateway_ref,
        amount: input.amount,
        idempotencyKey: prepared.refundId,
        reason: input.reason,
      });
    } catch (error) {
      if (error instanceof GatewayError && !error.retryable)
        await db.execute(
          sql`UPDATE refunds SET status = 'failed' WHERE id = ${prepared.refundId} AND status = 'pending'`,
        );
      throw error;
    }

    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE refunds SET gateway_ref = COALESCE(gateway_ref, ${result.refundRef}) WHERE id = ${prepared.refundId}`);
      if (result.status === 'failed') {
        await tx.execute(
          sql`UPDATE refunds SET status = 'failed' WHERE id = ${prepared.refundId} AND status = 'pending'`,
        );
      } else if (result.status === 'succeeded') {
        const payment = (
          await tx.execute<PaymentRow>(sql`
            SELECT id, order_id, gateway, gateway_ref, status, currency, amount::text AS amount,
                   captured::text AS captured, refunded::text AS refunded
            FROM payments WHERE id = ${input.paymentId} FOR UPDATE`)
        ).rows[0]!;
        await this.settleRefund(tx, payment, prepared.refundId, input.amount);
      }
    });
    const final = (
      await db.execute<{ status: RefundRecord['status'] }>(
        sql`SELECT status FROM refunds WHERE id = ${prepared.refundId}`,
      )
    ).rows[0]!;
    return {
      id: prepared.refundId,
      paymentId: input.paymentId,
      amount: input.amount,
      status: final.status,
    };
  }

  /** A refund confirmed by webhook (ours, or one made in the gateway's dashboard). */
  private async onRefundSucceeded(
    tx: Tx,
    payment: PaymentRow,
    currency: string,
    refundRef: string,
    amount: Money,
  ): Promise<ApplyOutcome> {
    if (amount.currency !== currency) return 'needs_attention';
    let refund = (
      await tx.execute<{ id: string; status: string }>(sql`
        SELECT id, status FROM refunds WHERE payment_id = ${payment.id} AND gateway_ref = ${refundRef}`)
    ).rows[0];
    if (!refund) {
      // Made outside Sold (gateway dashboard). Record it so our books match the gateway's.
      refund = (
        await tx.execute<{ id: string; status: string }>(sql`
          INSERT INTO refunds (payment_id, amount, currency, reason, actor, idempotency_key, gateway_ref)
          VALUES (${payment.id}, ${amount.amount}::bigint, ${currency}, 'refunded at gateway', 'gateway',
                  ${`gw:${payment.gateway}:${refundRef}`}, ${refundRef})
          ON CONFLICT (idempotency_key) DO UPDATE SET gateway_ref = EXCLUDED.gateway_ref
          RETURNING id, status`)
      ).rows[0]!;
    }
    if (refund.status === 'succeeded') return 'ignored';
    if (payment.status !== 'captured' && payment.status !== 'partially_refunded') return 'deferred';
    await this.settleRefund(tx, payment, refund.id, amount);
    return 'applied';
  }

  /** Apply a succeeded refund exactly once: guarded by the pending→succeeded transition of the refund row. */
  private async settleRefund(
    tx: Tx,
    payment: PaymentRow,
    refundId: string,
    amount: Money,
  ): Promise<void> {
    const flipped = await tx.execute(sql`
      UPDATE refunds SET status = 'succeeded' WHERE id = ${refundId} AND status <> 'succeeded' RETURNING id`);
    if (flipped.rows.length === 0) return;
    const updated = (
      await tx.execute<{ captured: string; refunded: string }>(sql`
        UPDATE payments
        SET refunded = refunded + ${amount.amount}::bigint,
            status = CASE WHEN refunded + ${amount.amount}::bigint >= captured THEN 'refunded' ELSE 'partially_refunded' END
        WHERE id = ${payment.id}
        RETURNING captured::text AS captured, refunded::text AS refunded`)
    ).rows[0]!;
    if (BigInt(updated.refunded) >= BigInt(updated.captured)) {
      try {
        await this.orders.transition(tx, payment.order_id, 'refunded', {
          actor: `payment:${payment.gateway}`,
          reason: 'fully refunded',
        });
      } catch (error) {
        // Already cancelled/refunded, or not in a refundable state: the payment record is still correct.
        if (!(error instanceof ConflictError)) throw error;
      }
    }
  }

  /**
   * Refund money that arrived for an order that was already cancelled. Idempotent (fixed key per payment): safe
   * to run on a schedule.
   */
  async reconcileOrphans(db: PrimaryDb, limit = 50): Promise<number> {
    const rows = (
      await db.execute<{ id: string; captured: string; refunded: string; currency: string }>(sql`
        SELECT p.id, p.captured::text AS captured, p.refunded::text AS refunded, p.currency
        FROM payments p JOIN orders o ON o.id = p.order_id
        WHERE p.status IN ('captured', 'partially_refunded') AND o.status = 'cancelled'
        ORDER BY p.updated_at LIMIT ${limit}`)
    ).rows;
    let n = 0;
    for (const row of rows) {
      const remaining = BigInt(row.captured) - BigInt(row.refunded);
      if (remaining <= 0n) continue;
      await this.refund(db, {
        paymentId: row.id,
        amount: Money.of(remaining, row.currency.trim()),
        reason: 'order was cancelled before payment arrived',
        actor: 'system',
        idempotencyKey: `orphan:${row.id}:${row.refunded}`,
      });
      n++;
    }
    return n;
  }

  /** Offline gateways (bank transfer, cash on delivery): an admin confirms the money arrived. */
  async confirmManually(db: PrimaryDb, paymentId: string, actor: string): Promise<ApplyOutcome> {
    const p = (
      await db.execute<{
        gateway: string;
        gateway_ref: string | null;
        currency: string;
        amount: string;
      }>(sql`
        SELECT gateway, gateway_ref, currency, amount::text AS amount FROM payments WHERE id = ${paymentId}`)
    ).rows[0];
    if (!p?.gateway_ref) throw new NotFoundError('Payment', paymentId);
    const event: GatewayEvent = {
      eventId: `manual:${paymentId}:captured`,
      type: 'payment.captured',
      gatewayRef: p.gateway_ref,
      amount: Money.of(BigInt(p.amount), p.currency.trim()),
    };
    await db.execute(sql`
      INSERT INTO payment_events (gateway, event_id, type, payload)
      VALUES (${p.gateway}, ${event.eventId}, ${event.type}, ${JSON.stringify({ ...(encodeEvent(event) as Record<string, JsonSafe>), actor })}::jsonb)
      ON CONFLICT (gateway, event_id) DO NOTHING`);
    const summary: WebhookSummary = {
      received: 1,
      applied: 0,
      duplicates: 0,
      deferred: 0,
      needsAttention: 0,
    };
    await this.processStored(db, p.gateway, event, summary);
    return summary.applied ? 'applied' : summary.needsAttention ? 'needs_attention' : 'ignored';
  }
}

// -----------------------------------------------------------------------------------------------------------------
// Event storage codec: Money is stored as {amount, currency} and rebuilt on read.
// -----------------------------------------------------------------------------------------------------------------

function encodeEvent(event: GatewayEvent): JsonSafe {
  return toJsonSafe(event);
}

function decodeEvent(payload: JsonSafe): GatewayEvent {
  const raw = fromJsonSafe<Record<string, unknown>>(payload);
  const amount = raw.amount as { amount: string | bigint; currency: string } | undefined;
  return (amount
    ? { ...raw, amount: Money.of(BigInt(amount.amount), amount.currency) }
    : raw) as unknown as GatewayEvent;
}
