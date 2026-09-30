import { createHmac, timingSafeEqual } from 'node:crypto';
import { Money } from '@sold/core';
import type { GatewayError } from './gateway';
import {
  WebhookVerificationError,
  type CreatePaymentRequest,
  type CreatePaymentResult,
  type GatewayEvent,
  type GatewayRefundRequest,
  type GatewayRefundResult,
  type PaymentGateway,
} from './gateway';

/** Wire format of the mock gateway's webhooks (JSON), signed with HMAC-SHA256 in `x-mock-signature`. */
export interface MockWebhookEvent {
  id: string;
  type: GatewayEvent['type'];
  ref: string;
  amount?: string;
  currency?: string;
  refundRef?: string;
  code?: string;
}

/**
 * Deterministic in-memory gateway for tests and local development. Behaves like a real one where it matters:
 * idempotent by key, records every call, can be told to fail, and delivers signed webhooks.
 */
export class MockGateway implements PaymentGateway {
  readonly id: string;
  readonly displayName = 'Mock gateway';
  readonly calls = { createPayment: 0, refund: 0 };
  private readonly payments = new Map<string, CreatePaymentResult>();
  private readonly refunds = new Map<string, GatewayRefundResult>();
  private failNext: GatewayError | null = null;
  /** Result the next refund reports (default: succeeded synchronously). */
  refundStatus: GatewayRefundResult['status'] = 'succeeded';
  currencies: readonly string[] | null = null;

  constructor(
    private readonly secret = 'mock-secret',
    id = 'mock',
  ) {
    this.id = id;
  }

  supportsCurrency(currency: string): boolean {
    return this.currencies ? this.currencies.includes(currency) : true;
  }

  failNextCall(error: GatewayError): void {
    this.failNext = error;
  }

  private maybeFail(): void {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
  }

  async createPayment(req: CreatePaymentRequest): Promise<CreatePaymentResult> {
    this.calls.createPayment++;
    this.maybeFail();
    const prior = this.payments.get(req.paymentId);
    if (prior) return prior; // idempotent by key, exactly like a real gateway
    const result: CreatePaymentResult = {
      gatewayRef: `mock_pi_${req.paymentId}`,
      status: 'requires_action',
      clientSecret: `secret_${req.paymentId}`,
    };
    this.payments.set(req.paymentId, result);
    return result;
  }

  async refund(req: GatewayRefundRequest): Promise<GatewayRefundResult> {
    this.calls.refund++;
    this.maybeFail();
    const prior = this.refunds.get(req.idempotencyKey);
    if (prior) return prior;
    const result: GatewayRefundResult = {
      refundRef: `mock_re_${req.idempotencyKey}`,
      status: this.refundStatus,
    };
    this.refunds.set(req.idempotencyKey, result);
    return result;
  }

  parseWebhook(rawBody: string, headers: Headers): GatewayEvent[] {
    const given = headers.get('x-mock-signature') ?? '';
    const want = sign(this.secret, rawBody);
    if (given.length !== want.length || !timingSafeEqual(Buffer.from(given), Buffer.from(want)))
      throw new WebhookVerificationError();
    const events = JSON.parse(rawBody) as MockWebhookEvent[];
    return events.map((e): GatewayEvent => {
      switch (e.type) {
        case 'payment.captured':
          return {
            eventId: e.id,
            type: e.type,
            gatewayRef: e.ref,
            amount: Money.of(BigInt(e.amount ?? '0'), e.currency ?? 'AUD'),
          };
        case 'payment.failed':
          return { eventId: e.id, type: e.type, gatewayRef: e.ref, code: e.code ?? 'declined' };
        case 'refund.succeeded':
          return {
            eventId: e.id,
            type: e.type,
            gatewayRef: e.ref,
            refundRef: e.refundRef ?? '',
            amount: Money.of(BigInt(e.amount ?? '0'), e.currency ?? 'AUD'),
          };
        case 'refund.failed':
          return { eventId: e.id, type: e.type, gatewayRef: e.ref, refundRef: e.refundRef ?? '' };
        default:
          return { eventId: e.id, type: e.type, gatewayRef: e.ref } as GatewayEvent;
      }
    });
  }

  /** Build a signed delivery for `PaymentService.handleWebhook`. */
  delivery(events: MockWebhookEvent[]): { rawBody: string; headers: Headers } {
    const rawBody = JSON.stringify(events);
    return { rawBody, headers: new Headers({ 'x-mock-signature': sign(this.secret, rawBody) }) };
  }
}

const sign = (secret: string, body: string): string =>
  createHmac('sha256', secret).update(body).digest('hex');
