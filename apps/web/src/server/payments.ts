import { ManualGateway, PaymentService, StripeGateway, type PaymentGateway } from '@sold/payments';
import type { Commerce } from '@sold/commerce';
import type { Env } from '@sold/core/env';

/** Gateways enabled for this instance: manual always; Stripe when both secrets are configured. */
export function buildGateways(env: Env): PaymentGateway[] {
  const gateways: PaymentGateway[] = [new ManualGateway()];
  if (env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET)
    gateways.push(
      new StripeGateway({
        secretKey: env.STRIPE_SECRET_KEY,
        webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      }),
    );
  return gateways;
}

export function buildPayments(env: Env, commerce: Commerce): PaymentService {
  return new PaymentService({ gateways: buildGateways(env), orders: commerce.orders });
}

interface Holder {
  payments?: PaymentService;
}
const holder = globalThis as unknown as { __soldPayments?: Holder };

export function getPaymentsFor(env: Env, commerce: Commerce): PaymentService {
  const slot = (holder.__soldPayments ??= {});
  slot.payments ??= buildPayments(env, commerce);
  return slot.payments;
}
