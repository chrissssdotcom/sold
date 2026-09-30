import { z } from 'zod';
import type { HookMap, HookName } from '@sold/extension-sdk';

/**
 * What an interceptor is allowed to change. Base validates every `modify` against these strict schemas
 * before applying it, so a buggy extension cannot corrupt a payload with unexpected fields or values.
 */
export const hookModifySchemas: { [H in HookName]: z.ZodType<HookMap[H]['modify']> } = {
  'cart.item.adding': z
    .object({ quantity: z.number().int().min(1).max(10_000).optional() })
    .strict(),
  'checkout.placing': z.object({}).strict(),
};
