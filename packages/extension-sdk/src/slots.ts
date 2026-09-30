import type { ComponentType } from 'react';

/**
 * Named UI injection points. Base declares these; a new slot is a Base change (and a minor version bump).
 * Interface merging lets a first-party extension declare slots of its own.
 */
export interface SlotMap {
  'storefront.header.end': Record<string, never>;
  'storefront.footer': Record<string, never>;
  'product.detail.aside': { productId: string };
  'cart.summary.footer': { cartId: string };
  'checkout.summary.footer': { cartId: string };
  'account.dashboard': { customerId: string };
  'admin.dashboard.widgets': Record<string, never>;
  'admin.order.actions': { orderId: string };
  'admin.product.editor.sidebar': { productId: string };
}

export type SlotName = keyof SlotMap;

/** Lazily loaded so slot components never bloat bundles that do not render them. */
export type LazyComponent<P> = () => Promise<{ default: ComponentType<P> }>;

export interface SlotContribution<K extends SlotName = SlotName> {
  slot: K;
  /** Unique within the extension. */
  id: string;
  component: LazyComponent<SlotMap[K]>;
  /** Lower renders first. Default 100. */
  order?: number;
  /** Permission required to see it (admin slots). */
  permission?: string;
}
