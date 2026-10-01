import { EnvelopeCrypto, rootKeyFromBase64 } from '@sold/core/crypto';
import type { Env } from '@sold/core/env';
import { WebhookService } from '@sold/platform';

const LOCAL_DEV_ROOT = Buffer.alloc(32, 'sold-local-dev-key-not-a-secret').toString('base64');

/** Webhooks sign with per-endpoint secrets that are stored encrypted under the instance key. Private targets only in local/ephemeral. */
export function buildWebhooks(env: Env): WebhookService {
  const root =
    env.SOLD_SECRET_KEY ?? (env.SOLD_ENVIRONMENT === 'local' ? LOCAL_DEV_ROOT : undefined);
  if (!root) throw new Error('SOLD_SECRET_KEY is required for webhooks');
  const env_ = env.SOLD_ENVIRONMENT;
  return new WebhookService(new EnvelopeCrypto(rootKeyFromBase64(root)), {
    allowPrivate: env_ === 'local',
  });
}

/** Events a webhook may subscribe to: the facts Base publishes. */
export const WEBHOOK_EVENTS = [
  'order.placed',
  'order.status_changed',
  'payment.captured',
  'cart.updated',
  'page.published',
  'page.unpublished',
] as const;
