/**
 * Storefront events: a tiny browser bus so extensions (analytics, pixels) can react to what shoppers do without Base
 * knowing about any vendor. Emitters are Base/theme code; listeners are extension `*.client.tsx` files, which must still
 * check consent before sending anything anywhere (`window.__sold.consent`).
 */
export type StorefrontEvent =
  | { type: 'view_item'; productId: string; currency: string; value: string }
  | { type: 'add_to_cart'; variantId: string; quantity: number; currency: string }
  | { type: 'purchase'; orderId: string; currency: string; value: string };

export const STOREFRONT_EVENT = 'sold:event';

export function emitStorefrontEvent(event: StorefrontEvent): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<StorefrontEvent>(STOREFRONT_EVENT, { detail: event }));
}
