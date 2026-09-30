import type { InterceptorContext } from '@sold/extension-sdk';
import { describe, expect, it } from 'vitest';
import { maxQuantity } from './max-quantity.interceptor';
import type { Settings } from './settings';

const ctx = (maxQuantityPerLine: number) =>
  ({
    settings: { get: async () => ({ maxQuantityPerLine }) as Settings },
  }) as unknown as InterceptorContext<Settings>;
const item = (quantity: number) => ({ cartId: 'c1', variantId: 'v1', quantity });

describe('max-quantity interceptor', () => {
  it('vetoes a line above the configured maximum', async () => {
    expect(await maxQuantity.handler(item(11), ctx(10))).toEqual({
      veto: { code: 'max_quantity_exceeded', message: 'You can add at most 10 of this item.' },
    });
  });

  it('lets a line at or below the maximum through', async () => {
    expect(await maxQuantity.handler(item(10), ctx(10))).toBeUndefined();
    expect(await maxQuantity.handler(item(1), ctx(10))).toBeUndefined();
  });

  it('fails open: a broken interceptor must not block adding to the cart', () => {
    expect(maxQuantity.failPolicy).toBe('open');
  });
});
