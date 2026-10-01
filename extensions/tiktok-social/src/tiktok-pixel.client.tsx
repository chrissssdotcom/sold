'use client';
import { useEffect } from 'react';

interface Ttq extends Array<unknown> {
  methods?: string[];
  setAndDefer?: (target: Record<string, unknown>, method: string) => void;
  load?: (code: string, options?: object) => void;
  track?: (event: string, props?: object, opts?: object) => void;
  page?: () => void;
  _i?: Record<string, unknown[]>;
  _t?: Record<string, number>;
  _o?: Record<string, object>;
}
/** Base publishes the shopper's cookie choice here (see docs/extending.md). Read-only for extensions. */
const marketingAllowed = (): boolean =>
  (window as unknown as { __sold?: { consent?: { marketing?: boolean } } }).__sold?.consent
    ?.marketing === true;

interface TtqWindow {
  ttq?: Ttq;
  TiktokAnalyticsObject?: string;
}

type SoldEvent =
  | { type: 'view_item'; productId: string; currency: string; value: string }
  | { type: 'add_to_cart'; variantId: string; quantity: number; currency: string }
  | { type: 'purchase'; orderId: string; currency: string; value: string };

const major = (minor: string, currency: string) => {
  const digits =
    new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  const n = BigInt(minor);
  const d = 10n ** BigInt(digits);
  return Number(n / d) + Number(n % d) / Number(d);
};

/**
 * TikTok's documented base-code bootstrap (queue stub + async script), written out so it only runs after consent.
 * NOT verified against TikTok here (no network/account): confirm in Events Manager > Test events before relying on it.
 */
function bootstrap(code: string): Ttq {
  const w = window as unknown as TtqWindow;
  w.TiktokAnalyticsObject = 'ttq';
  const ttq: Ttq = (w.ttq = w.ttq ?? ([] as unknown as Ttq));
  ttq.methods = [
    'page',
    'track',
    'identify',
    'instances',
    'debug',
    'on',
    'off',
    'once',
    'ready',
    'alias',
    'group',
  ];
  ttq.setAndDefer = (target, method) => {
    target[method] = (...args: unknown[]) =>
      (target as unknown as unknown[]).push([method, ...args]);
  };
  for (const m of ttq.methods) ttq.setAndDefer(ttq as unknown as Record<string, unknown>, m);
  ttq._i = ttq._i ?? {};
  ttq._i[code] = [];
  ttq._t = { ...(ttq._t ?? {}), [code]: Date.now() };
  ttq._o = { ...(ttq._o ?? {}), [code]: {} };
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=${encodeURIComponent(code)}&lib=ttq`;
  document.head.appendChild(script);
  ttq.page?.();
  return ttq;
}

/**
 * The TikTok pixel, behind consent. Nothing is requested from TikTok until the shopper has accepted advertising cookies;
 * if they later withdraw, this stops sending (a loaded script cannot be unloaded: a reload ends it).
 * Mounted by the storefront shell through the `storefront.footer` slot.
 */
export default function TikTokPixel() {
  useEffect(() => {
    let code: string | null = null;
    let ttq: Ttq | null = null;
    const allowed = () => marketingAllowed();

    const ensure = (): Ttq | null => {
      if (!code || !allowed()) return null;
      ttq ??= bootstrap(code);
      return ttq;
    };
    const track = (name: string, props: object, eventId?: string) => {
      const t = ensure();
      t?.track?.(name, props, eventId ? { event_id: eventId } : undefined);
    };

    const onEvent = (e: Event) => {
      const ev = (e as CustomEvent<SoldEvent>).detail;
      if (ev.type === 'view_item')
        track('ViewContent', {
          content_id: ev.productId,
          content_type: 'product',
          currency: ev.currency,
          value: major(ev.value, ev.currency),
        });
      else if (ev.type === 'add_to_cart')
        track('AddToCart', {
          content_id: ev.variantId,
          content_type: 'product',
          quantity: ev.quantity,
          currency: ev.currency,
        });
      else if (ev.type === 'purchase')
        track(
          'PlaceAnOrder',
          { content_type: 'product', currency: ev.currency, value: major(ev.value, ev.currency) },
          `order-${ev.orderId}`,
        );
    };
    const onConsent = () => void ensure();

    fetch('/x/tiktok-social/config')
      .then((r) => r.json())
      .then((c: { pixelCode: string | null }) => {
        code = c.pixelCode;
        void ensure();
      })
      .catch(() => undefined);

    window.addEventListener('sold:event', onEvent);
    window.addEventListener('sold:consent', onConsent);
    return () => {
      window.removeEventListener('sold:event', onEvent);
      window.removeEventListener('sold:consent', onConsent);
    };
  }, []);
  return null;
}
