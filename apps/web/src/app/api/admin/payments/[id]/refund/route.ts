import { z } from 'zod';
import { adminRoute } from '../../../../../../server/admin-route';
import { json } from '../../../../../../server/commerce-http';
import { body, parseId } from '../../../../../../server/admin/http';
import { getCommerce } from '../../../../../../server/commerce';
import { Money } from '@sold/core';
import { getRuntime } from '../../../../../../server/runtime';
import { getPaymentsFor } from '../../../../../../server/payments';

export const dynamic = 'force-dynamic';
const input = z.strictObject({
  amount: z.string().regex(/^[1-9]\d{0,15}$/),
  currency: z.string().length(3),
  reason: z.string().min(1).max(500),
  /** Supplied by the client so a double-click or retry cannot refund twice. */
  idempotencyKey: z.string().min(8).max(100),
});

export const POST = adminRoute('payments:refund', async (req, { db, audit, user }) => {
  const parts = new URL(req.url).pathname.split('/');
  const paymentId = parseId(parts[parts.length - 2]);
  const v = await body(req, input);
  const payments = getPaymentsFor(getRuntime().env, await getCommerce());
  const refund = await payments.refund(db, {
    paymentId,
    amount: Money.of(BigInt(v.amount), v.currency),
    reason: v.reason,
    actor: user.email,
    idempotencyKey: `admin:${paymentId}:${v.idempotencyKey}`,
  });
  await audit(
    'payment.refund',
    { type: 'payment', id: paymentId },
    { amount: v.amount, currency: v.currency, reason: v.reason },
  );
  return json(refund, { status: 201 });
});
