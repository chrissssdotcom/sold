import { Money } from '@sold/core';
import { z } from 'zod';

/**
 * Promotion definitions. These are validated with Zod at the boundary (admin API, DB rows, config) and then handed
 * to the pure pricing engine (`computePricing`). Everything monetary is `Money` (bigint minor units); percentages are
 * integer basis points (1 bp = 0.01%), so there is no float anywhere.
 *
 * `usageLimit` / `perCustomerLimit` are NOT enforced by the engine (it has no I/O). Checkout enforces them against
 * its redemption ledger; the engine only echoes them in each applied discount (`AppliedDiscount.usage`) so checkout
 * knows which limits to check and which redemptions to record.
 */

/** Money as a `Money` instance, or its JSON form `{ amount: "1999", currency: "AUD" }` (amount is minor units). */
export const moneySchema = z.union([
  z.custom<Money>((value) => value instanceof Money, { message: 'Expected a Money value' }),
  z
    .strictObject({
      amount: z.union([z.bigint(), z.string().regex(/^-?\d+$/, 'Minor units must be an integer')]),
      currency: z.string().length(3),
    })
    .transform((value, ctx): Money => {
      try {
        return Money.fromJSON(value);
      } catch {
        ctx.issues.push({ code: 'custom', message: 'Unknown currency', input: value });
        return z.NEVER;
      }
    }),
]);

const dateSchema = z.union([
  z.date(),
  z.iso.datetime({ offset: true }).transform((text) => new Date(text)),
]);

/** Which cart lines a promotion targets. `order` = every line. `tags` matches when the line has ANY listed tag. */
export const promotionScopeSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('order') }),
  z.strictObject({
    type: z.literal('products'),
    productIds: z.array(z.string().min(1)).min(1),
  }),
  z.strictObject({ type: z.literal('tags'), tags: z.array(z.string().min(1)).min(1) }),
]);
export type PromotionScope = z.output<typeof promotionScopeSchema>;

const basisPoints = z.number().int().min(1).max(10_000);
const positiveInt = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

const commonShape = {
  id: z.string().min(1),
  name: z.string().min(1),
  /** Coupon code, matched case-insensitively (after trimming). `null` = automatic promotion. */
  code: z.string().trim().min(1).max(64).nullable().default(null),
  /** Active when `now >= startsAt`. `null` = no start. */
  startsAt: dateSchema.nullable().default(null),
  /** Active while `now < endsAt` (exclusive). `null` = no end. */
  endsAt: dateSchema.nullable().default(null),
  /** Minimum cart LIST subtotal (before any discount) for the promotion to be eligible. */
  minSubtotal: moneySchema.nullable().default(null),
  /** Total redemptions allowed. Not enforced by the engine; echoed in the applied discount. */
  usageLimit: positiveInt.nullable().default(null),
  /** Redemptions allowed per customer. Not enforced by the engine; echoed in the applied discount. */
  perCustomerLimit: positiveInt.nullable().default(null),
  /** May be combined with other promotions. See `computePricing` for the exact stacking rules. */
  stackable: z.boolean().default(true),
  /** Lower is evaluated first. Ties are broken by `id` (code-unit order), so evaluation is deterministic. */
  priority: z.number().finite().default(100),
  /** Among promotions sharing a group, only the one giving the largest discount is applied. */
  exclusiveGroup: z.string().min(1).optional(),
};

const percentOff = z.strictObject({
  ...commonShape,
  kind: z.literal('percent_off'),
  scope: promotionScopeSchema.default({ type: 'order' }),
  basisPoints,
});

const fixedOff = z.strictObject({
  ...commonShape,
  kind: z.literal('fixed_off'),
  scope: promotionScopeSchema.default({ type: 'order' }),
  /** Taken off the eligible net ONCE (not per unit), capped at the eligible net. */
  amount: moneySchema,
});

const buyXGetY = z.strictObject({
  ...commonShape,
  kind: z.literal('buy_x_get_y'),
  scope: promotionScopeSchema,
  buyQuantity: positiveInt,
  getQuantity: positiveInt,
  reward: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('free') }),
    z.strictObject({ type: z.literal('percent'), basisPoints }),
  ]),
  /**
   * `cheapest`: eligible units are pooled across lines, sorted by unit price descending and cut into groups of
   * buy+get; the `get` cheapest units of each full group get the reward.
   * `same`: each line is its own pool (buy X of an item, get Y more of THAT item).
   */
  mode: z.enum(['cheapest', 'same']).default('cheapest'),
});

const freeShipping = z.strictObject({
  ...commonShape,
  kind: z.literal('free_shipping'),
});

export const promotionSchema = z
  .discriminatedUnion('kind', [percentOff, fixedOff, buyXGetY, freeShipping])
  .superRefine((promo, ctx) => {
    if (promo.startsAt && promo.endsAt && promo.startsAt.getTime() >= promo.endsAt.getTime())
      ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'endsAt must be after startsAt' });
    if (promo.minSubtotal?.isNegative())
      ctx.addIssue({
        code: 'custom',
        path: ['minSubtotal'],
        message: 'minSubtotal must not be negative',
      });
    if (promo.kind === 'fixed_off' && promo.amount.amount <= 0n)
      ctx.addIssue({ code: 'custom', path: ['amount'], message: 'amount must be positive' });
  });

export type PromotionDef = z.output<typeof promotionSchema>;
export type PromotionInput = z.input<typeof promotionSchema>;
export type PromotionKind = PromotionDef['kind'];

/** Validate untrusted promotion data (throws `ZodError`). */
export function parsePromotion(input: unknown): PromotionDef {
  return promotionSchema.parse(input);
}

/** Normalise a coupon code for case-insensitive comparison. */
export function normalizeCouponCode(code: string): string {
  return code.trim().toUpperCase();
}
