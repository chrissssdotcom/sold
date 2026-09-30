import { WebhookVerificationError } from '@sold/payments';
import { getCommerce } from '../../../../../server/commerce';
import { json } from '../../../../../server/commerce-http';
import { getPaymentsFor } from '../../../../../server/payments';
import { route } from '../../../../../server/route';
import { getRuntime } from '../../../../../server/runtime';

export const dynamic = 'force-dynamic';
const MAX_BYTES = 1024 * 1024;

/**
 * Gateway webhooks. Reads the RAW body (signatures cover the exact bytes). 400 = not authentic (do not retry),
 * 200 = stored (applied, duplicate or deferred), 5xx = transient (the gateway retries).
 */
export const POST = route(async (request, ctx) => {
  const gatewayId = new URL(request.url).pathname.split('/').pop() ?? '';
  const raw = await request.text();
  if (raw.length > MAX_BYTES)
    return json({ error: { code: 'payload_too_large' } }, { status: 413 });
  const rt = getRuntime();
  const payments = getPaymentsFor(rt.env, await getCommerce());
  try {
    const summary = await payments.handleWebhook(rt.db.primary, gatewayId, raw, request.headers);
    return json({ ok: true, ...summary });
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      ctx.log.warn({ gatewayId }, 'webhook rejected: bad signature');
      return json({ error: { code: 'invalid_signature' } }, { status: 400 });
    }
    if ((error as { code?: string }).code === 'gateway_unavailable')
      return json({ error: { code: 'unknown_gateway' } }, { status: 404 });
    throw error;
  }
});
