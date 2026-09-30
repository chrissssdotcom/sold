import type { Money } from '@sold/core';

export const paymentStatuses = [
  'pending',
  'requires_action',
  'authorized',
  'captured',
  'partially_refunded',
  'refunded',
  'failed',
  'voided',
] as const;
export type PaymentStatus = (typeof paymentStatuses)[number];

export interface CreatePaymentRequest {
  /** Our payment id: the gateway idempotency key, so a retried call can never create a second charge. */
  paymentId: string;
  orderId: string;
  orderNumber: string;
  amount: Money;
  customerEmail: string;
  /** Where the shopper returns after a redirect-style flow. */
  returnUrl?: string;
}

export interface CreatePaymentResult {
  /** The gateway's id for this payment (a PaymentIntent, a session, an offline reference). */
  gatewayRef: string;
  status: Extract<
    PaymentStatus,
    'pending' | 'requires_action' | 'authorized' | 'captured' | 'failed'
  >;
  /** For in-page confirmation (e.g. Stripe Elements). Never logged or stored. */
  clientSecret?: string;
  /** For redirect flows and offline instructions. */
  redirectUrl?: string;
  instructions?: string;
}

export interface GatewayRefundRequest {
  gatewayRef: string;
  amount: Money;
  /** Idempotency key: a retried refund call can never refund twice. */
  idempotencyKey: string;
  reason: string;
}

export interface GatewayRefundResult {
  refundRef: string | null;
  status: 'succeeded' | 'pending' | 'failed';
}

/** Gateway events, normalised. Adapters translate their vendor's vocabulary into these and nothing else. */
export type GatewayEvent =
  | { eventId: string; type: 'payment.requires_action'; gatewayRef: string }
  | { eventId: string; type: 'payment.authorized'; gatewayRef: string }
  | { eventId: string; type: 'payment.captured'; gatewayRef: string; amount: Money }
  | { eventId: string; type: 'payment.failed'; gatewayRef: string; code: string }
  | { eventId: string; type: 'payment.voided'; gatewayRef: string }
  | {
      eventId: string;
      type: 'refund.succeeded';
      gatewayRef: string;
      refundRef: string;
      amount: Money;
    }
  | { eventId: string; type: 'refund.failed'; gatewayRef: string; refundRef: string };

export class WebhookVerificationError extends Error {
  constructor(message = 'Webhook signature verification failed') {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

export class GatewayError extends Error {
  constructor(
    message: string,
    /** Whether retrying the same call (same idempotency key) may succeed. */
    readonly retryable: boolean,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

/**
 * A payment gateway. Vendors sit behind this interface (Section 8B/5: gateways are pluggable); nothing outside an
 * adapter may import a vendor SDK or know a vendor's event names. Calls that move money take an idempotency key.
 */
export interface PaymentGateway {
  readonly id: string;
  readonly displayName: string;
  /** Currencies it can settle; an order in another currency is refused before any call is made. */
  supportsCurrency(currency: string): boolean;
  createPayment(req: CreatePaymentRequest): Promise<CreatePaymentResult>;
  refund(req: GatewayRefundRequest): Promise<GatewayRefundResult>;
  /**
   * Verify the delivery is authentic and translate it. `rawBody` is the exact bytes received (signatures cover the
   * raw body, so it must never be re-serialised). Throws `WebhookVerificationError` when it is not authentic.
   */
  parseWebhook(rawBody: string, headers: Headers): GatewayEvent[];
}
