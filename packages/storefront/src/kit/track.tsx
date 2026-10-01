'use client';
import { useEffect } from 'react';
import { emitStorefrontEvent } from './events';

/** Renders nothing; announces that this product was viewed. `value` is the price in minor units. */
export function TrackViewItem({
  productId,
  currency,
  value,
}: {
  productId: string;
  currency: string;
  value: string;
}) {
  useEffect(() => {
    emitStorefrontEvent({ type: 'view_item', productId, currency, value });
  }, [productId, currency, value]);
  return null;
}
