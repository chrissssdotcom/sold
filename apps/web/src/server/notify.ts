import {
  ConsoleTransport,
  NotificationService,
  PostmarkTransport,
  SmtpTransport,
  type EmailTransport,
} from '@sold/notify';
import type { Env } from '@sold/core/env';
import { markets } from '@sold/storefront/i18n';
import instanceConfig from '../../../../sold.config';
import { deriveCartKey, signOrderToken } from './cart-token';

const LOCAL_DEV_ROOT = Buffer.alloc(32, 'sold-local-dev-key-not-a-secret').toString('base64');

export const publicUrl = (env: Env): string =>
  (env.SOLD_PUBLIC_URL ?? 'http://localhost:3000').replace(/\/$/, '');

export function buildNotifications(env: Env): NotificationService {
  return new NotificationService({
    site: { name: instanceConfig.instance.name, url: publicUrl(env) },
    from: env.EMAIL_FROM ?? `${instanceConfig.instance.name} <no-reply@localhost>`,
  });
}

/**
 * Which provider sends mail. Postmark, then SMTP. With neither: local development and ephemeral environments log the
 * email; anything else returns null, so mail stays safely queued (and visible on the dashboard) instead of being
 * silently dropped or "sent" to a log in production.
 */
export function buildTransport(env: Env): EmailTransport | null {
  if (env.POSTMARK_SERVER_TOKEN) return new PostmarkTransport(env.POSTMARK_SERVER_TOKEN);
  if (env.SMTP_URL) return new SmtpTransport(env.SMTP_URL);
  const env_ = env.SOLD_ENVIRONMENT;
  return env_ === 'local' || env_ === 'ephemeral' ? new ConsoleTransport() : null;
}

/** A signed link to an order page, valid for guests. Same key the storefront verifies with. */
export function orderLink(env: Env): (orderId: string) => string {
  const root =
    env.SOLD_SECRET_KEY ?? (env.SOLD_ENVIRONMENT === 'local' ? LOCAL_DEV_ROOT : undefined);
  return (orderId) => {
    if (!root) throw new Error('SOLD_SECRET_KEY is required to sign order links');
    const token = signOrderToken(deriveCartKey(root), orderId);
    return `${publicUrl(env)}/${markets[0]!.slug}/order/${token}`;
  };
}

/** Absolute storefront URL for a product handle. */
export function productLink(env: Env): (handle: string) => string {
  return (handle) => `${publicUrl(env)}/${markets[0]!.slug}/products/${encodeURIComponent(handle)}`;
}
