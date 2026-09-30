import { createHmac, timingSafeEqual } from 'node:crypto';
import { Money, currencyExponent } from '@sold/core';
import {
  GatewayError,
  WebhookVerificationError,
  type CreatePaymentRequest,
  type CreatePaymentResult,
  type GatewayEvent,
  type GatewayRefundRequest,
  type GatewayRefundResult,
  type PaymentGateway,
} from '../gateway';

/**
 * Stripe adapter over plain `fetch` (no SDK: one fewer dependency, and the wire format is what we verify).
 *
 * HONESTY NOTE: this was written from Stripe's documented API and tested against a local fake that implements the
 * subset used here (request encoding, idempotency headers, error classes) and against synthetic webhook fixtures
 * signed with the documented scheme. It has NOT been exercised against Stripe's live or test API (no credentials in
 * this environment). Before going live: run it against a Stripe test-mode account and confirm the event names below.
 *
 * Webhook endpoint must subscribe to: payment_intent.succeeded, payment_intent.payment_failed,
 * payment_intent.canceled, payment_intent.requires_action, payment_intent.amount_capturable_updated,
 * refund.created, refund.updated (and refund.failed where available).
 */
export interface StripeGatewayOptions {
  secretKey: string;
  webhookSecret: string;
  apiBase?: string;
  fetch?: typeof fetch;
  /** Currencies this account settles. Default: everything Sold knows (Stripe rejects what the account cannot take). */
  currencies?: readonly string[];
  /** Webhook timestamp tolerance in seconds (Stripe's default is 300). */
  toleranceSeconds?: number;
  now?: () => number;
  timeoutMs?: number;
}

const INTENT_STATUS: Record<string, CreatePaymentResult['status']> = {
  requires_payment_method: 'pending',
  requires_confirmation: 'pending',
  processing: 'pending',
  requires_action: 'requires_action',
  requires_capture: 'authorized',
  succeeded: 'captured',
  canceled: 'failed',
};

export class StripeGateway implements PaymentGateway {
  readonly id = 'stripe';
  readonly displayName = 'Card (Stripe)';
  private readonly opts: Required<
    Pick<StripeGatewayOptions, 'apiBase' | 'toleranceSeconds' | 'timeoutMs'>
  > &
    StripeGatewayOptions;

  constructor(opts: StripeGatewayOptions) {
    this.opts = {
      apiBase: 'https://api.stripe.com',
      toleranceSeconds: 300,
      timeoutMs: 10_000,
      ...opts,
    };
  }

  supportsCurrency(currency: string): boolean {
    return this.opts.currencies ? this.opts.currencies.includes(currency) : true;
  }

  async createPayment(req: CreatePaymentRequest): Promise<CreatePaymentResult> {
    assertStripeAmount(req.amount);
    const body = new URLSearchParams({
      amount: req.amount.amount.toString(),
      currency: req.amount.currency.toLowerCase(),
      'automatic_payment_methods[enabled]': 'true',
      receipt_email: req.customerEmail,
      'metadata[payment_id]': req.paymentId,
      'metadata[order_id]': req.orderId,
      'metadata[order_number]': req.orderNumber,
    });
    const intent = await this.call<{ id: string; status: string; client_secret?: string }>(
      'POST',
      '/v1/payment_intents',
      body,
      req.paymentId,
    );
    return {
      gatewayRef: intent.id,
      status: INTENT_STATUS[intent.status] ?? 'pending',
      ...(intent.client_secret ? { clientSecret: intent.client_secret } : {}),
    };
  }

  async refund(req: GatewayRefundRequest): Promise<GatewayRefundResult> {
    assertStripeAmount(req.amount);
    const r = await this.call<{ id: string; status: string }>(
      'POST',
      '/v1/refunds',
      new URLSearchParams({
        payment_intent: req.gatewayRef,
        amount: req.amount.amount.toString(),
        reason: 'requested_by_customer',
        'metadata[note]': req.reason.slice(0, 400),
      }),
      req.idempotencyKey,
    );
    return {
      refundRef: r.id,
      status:
        r.status === 'succeeded'
          ? 'succeeded'
          : r.status === 'failed' || r.status === 'canceled'
            ? 'failed'
            : 'pending',
    };
  }

  // ---- webhooks ----------------------------------------------------------------------------------------------

  parseWebhook(rawBody: string, headers: Headers): GatewayEvent[] {
    verifyStripeSignature({
      rawBody,
      header: headers.get('stripe-signature'),
      secret: this.opts.webhookSecret,
      toleranceSeconds: this.opts.toleranceSeconds,
      nowSeconds: Math.floor((this.opts.now?.() ?? Date.now()) / 1000),
    });
    let event: StripeEvent;
    try {
      event = JSON.parse(rawBody) as StripeEvent;
    } catch {
      throw new WebhookVerificationError('Malformed webhook body');
    }
    return translateStripeEvent(event);
  }

  // ---- transport ---------------------------------------------------------------------------------------------

  private async call<T>(
    method: 'POST' | 'GET',
    path: string,
    body: URLSearchParams | undefined,
    idempotencyKey: string,
  ): Promise<T> {
    const doFetch = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`${this.opts.apiBase}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.opts.secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          'idempotency-key': idempotencyKey,
        },
        ...(body ? { body: body.toString() } : {}),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (error) {
      // Network failure or timeout: the outcome is unknown, so retrying with the SAME idempotency key is exactly right.
      throw new GatewayError(
        `Stripe request failed: ${(error as Error).name}`,
        true,
        'network_error',
      );
    }
    const text = await res.text();
    if (res.ok) return JSON.parse(text) as T;
    let code = 'stripe_error';
    let message = `Stripe returned ${res.status}`;
    try {
      const e = (JSON.parse(text) as { error?: { code?: string; message?: string; type?: string } })
        .error;
      code = e?.code ?? e?.type ?? code;
      message = e?.message ?? message;
    } catch {
      /* non-JSON error body */
    }
    // 429 and 5xx are transient; other 4xx (card declined, bad request, auth) will not change on retry.
    throw new GatewayError(message, res.status === 429 || res.status >= 500, code);
  }
}

/** Stripe requires three-decimal currency amounts to be divisible by 10 (documented); refuse rather than be rejected. */
function assertStripeAmount(amount: Money): void {
  if (currencyExponent(amount.currency) === 3 && amount.amount % 10n !== 0n)
    throw new GatewayError(
      `Stripe requires ${amount.currency} amounts to be divisible by 10 minor units`,
      false,
      'unsupported_amount',
    );
}

// ---- signature verification (documented scheme: t=<ts>,v1=<hex HMAC-SHA256 of "<ts>.<raw body>">) ---------------

export function verifyStripeSignature(input: {
  rawBody: string;
  header: string | null;
  secret: string;
  toleranceSeconds: number;
  nowSeconds: number;
}): void {
  if (!input.header) throw new WebhookVerificationError('Missing Stripe-Signature header');
  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of input.header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') timestamp = v;
    else if (k === 'v1') signatures.push(v);
  }
  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || signatures.length === 0)
    throw new WebhookVerificationError('Malformed Stripe-Signature header');
  const expected = createHmac('sha256', input.secret)
    .update(`${timestamp}.${input.rawBody}`)
    .digest();
  const ok = signatures.some((sig) => {
    if (!/^[0-9a-f]{64}$/i.test(sig)) return false;
    return timingSafeEqual(expected, Buffer.from(sig, 'hex'));
  });
  if (!ok) throw new WebhookVerificationError();
  // Checked after the signature so an attacker cannot probe the clock with unsigned requests.
  if (Math.abs(input.nowSeconds - Number(timestamp)) > input.toleranceSeconds)
    throw new WebhookVerificationError('Webhook timestamp outside tolerance');
}

/** Test/support helper: produce a header exactly as Stripe documents it. */
export function signStripePayload(
  secret: string,
  rawBody: string,
  timestampSeconds: number,
): string {
  const v1 = createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody}`).digest('hex');
  return `t=${timestampSeconds},v1=${v1}`;
}

// ---- event translation ----------------------------------------------------------------------------------------

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export function translateStripeEvent(event: StripeEvent): GatewayEvent[] {
  const o = event.data?.object ?? {};
  const eventId = event.id;
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const int = (v: unknown): bigint | undefined =>
    typeof v === 'number' && Number.isSafeInteger(v) ? BigInt(v) : undefined;

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const id = str(o.id);
      const currency = str(o.currency)?.toUpperCase();
      const amount = int(o.amount_received) ?? int(o.amount);
      if (!id || !currency || amount === undefined) return [];
      return [
        { eventId, type: 'payment.captured', gatewayRef: id, amount: Money.of(amount, currency) },
      ];
    }
    case 'payment_intent.amount_capturable_updated': {
      const id = str(o.id);
      return id ? [{ eventId, type: 'payment.authorized', gatewayRef: id }] : [];
    }
    case 'payment_intent.requires_action': {
      const id = str(o.id);
      return id ? [{ eventId, type: 'payment.requires_action', gatewayRef: id }] : [];
    }
    case 'payment_intent.payment_failed': {
      const id = str(o.id);
      const err = o.last_payment_error as { code?: string } | null | undefined;
      return id
        ? [{ eventId, type: 'payment.failed', gatewayRef: id, code: err?.code ?? 'payment_failed' }]
        : [];
    }
    case 'payment_intent.canceled': {
      const id = str(o.id);
      return id ? [{ eventId, type: 'payment.voided', gatewayRef: id }] : [];
    }
    case 'refund.created':
    case 'refund.updated':
    case 'refund.failed':
    case 'charge.refund.updated': {
      const refundRef = str(o.id);
      const pi = str(o.payment_intent);
      const currency = str(o.currency)?.toUpperCase();
      const amount = int(o.amount);
      const status = event.type === 'refund.failed' ? 'failed' : str(o.status);
      if (!refundRef || !pi) return [];
      if (status === 'succeeded' && currency && amount !== undefined)
        return [
          {
            eventId,
            type: 'refund.succeeded',
            gatewayRef: pi,
            refundRef,
            amount: Money.of(amount, currency),
          },
        ];
      if (status === 'failed' || status === 'canceled')
        return [{ eventId, type: 'refund.failed', gatewayRef: pi, refundRef }];
      return []; // pending: wait for the update
    }
    default:
      return []; // Acknowledge and ignore everything we do not act on.
  }
}
