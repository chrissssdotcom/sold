import type { InterceptorContext, InterceptorDefinition } from '@sold/extension-sdk';
import type { Settings } from './settings';

/**
 * Interceptors live in `*.interceptor.ts` files. The lint rule keeps these files pure: no network, filesystem or
 * process imports, no `fetch`. They take part in a decision synchronously, with a hard time budget.
 */
export const maxQuantity: InterceptorDefinition<
  'cart.item.adding',
  InterceptorContext<Settings>
> = {
  hook: 'cart.item.adding',
  name: 'max-quantity',
  failPolicy: 'open', // if we are slow or broken, let the shopper add to cart
  async handler(item, ctx) {
    const { maxQuantityPerLine } = await ctx.settings.get(); // memory snapshot: no database on the hot path
    if (item.quantity > maxQuantityPerLine) {
      return {
        veto: {
          code: 'max_quantity_exceeded',
          message: `You can add at most ${maxQuantityPerLine} of this item.`,
        },
      };
    }
  },
};
