import { Money } from '@sold/core';
import { z } from 'zod';

/**
 * Shipping configuration, validated with Zod at the boundary.
 *
 * Money in config is written as decimal major-unit strings PER CURRENCY (`{ AUD: '9.95', JPY: '800' }`) and
 * parsed exactly: more decimals than the currency allows is an error, never silently rounded. A method that has no
 * price for the order currency is unavailable; prices are never converted between currencies.
 */

const currencyCode = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code, upper case');
const country = z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 code, upper case');
const region = z
  .string()
  .trim()
  .min(1)
  .transform((s) => s.toUpperCase());

/** `{ AUD: '9.95' }` in, `{ AUD: Money }` out. Non-negative, at least one currency. */
const priceMap = z.record(currencyCode, z.string()).transform((record, ctx) => {
  const out: Record<string, Money> = {};
  const entries = Object.entries(record);
  if (entries.length === 0) {
    ctx.issues.push({
      code: 'custom',
      message: 'at least one currency price is required',
      input: record,
    });
    return z.NEVER;
  }
  for (const [currency, text] of entries) {
    try {
      const money = Money.parse(text, currency);
      if (money.isNegative()) throw new RangeError('price must not be negative');
      out[currency] = money;
    } catch (e) {
      ctx.issues.push({
        code: 'custom',
        message: `${currency}: ${e instanceof Error ? e.message : String(e)}`,
        input: text,
      });
    }
  }
  return out;
});

const sameKeys = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
};

const common = {
  /** Stable id, unique within its zone. */
  id: z.string().min(1),
  label: z.string().min(1),
  carrier: z.string().min(1).optional(),
  estimatedDaysMin: z.number().int().min(0),
  estimatedDaysMax: z.number().int().min(0),
  /** Whether a free-shipping promotion zeroes this method. */
  promoEligible: z.boolean().default(true),
};

const FlatMethod = z.strictObject({ ...common, type: z.literal('flat'), prices: priceMap });

const WeightTableMethod = z.strictObject({
  ...common,
  type: z.literal('weight_table'),
  /**
   * Tiers in ascending order. A tier applies when the order's total weight is `<= maxGrams` (inclusive upper bound)
   * and above the previous tier's `maxGrams`. `maxGrams: null` (last tier only) means no upper limit; without it,
   * an order heavier than the last tier cannot use the method. Every tier must price the same currencies.
   */
  tiers: z
    .array(z.strictObject({ maxGrams: z.number().int().positive().nullable(), prices: priceMap }))
    .min(1)
    .superRefine((tiers, ctx) => {
      tiers.forEach((tier, i) => {
        const prev = tiers[i - 1];
        if (tier.maxGrams === null && i !== tiers.length - 1)
          ctx.addIssue({
            code: 'custom',
            message: 'only the last tier may be unbounded',
            path: [i],
          });
        if (
          prev &&
          prev.maxGrams !== null &&
          tier.maxGrams !== null &&
          tier.maxGrams <= prev.maxGrams
        )
          ctx.addIssue({
            code: 'custom',
            message: 'tiers must have strictly ascending maxGrams',
            path: [i],
          });
        if (prev && !sameKeys(prev.prices, tier.prices))
          ctx.addIssue({
            code: 'custom',
            message: 'every tier must price the same currencies',
            path: [i],
          });
      });
    }),
});

const PerItemMethod = z.strictObject({
  ...common,
  type: z.literal('per_item'),
  /** Price for each unit (quantities are summed across lines). */
  prices: priceMap,
});

const FreeOverMethod = z.strictObject({
  ...common,
  type: z.literal('free_over'),
  /** Free when the post-discount subtotal is AT LEAST this (`subtotal >= threshold`). */
  threshold: priceMap,
  /**
   * Flat price charged below the threshold. Omit to offer the method only once the threshold is reached
   * (then pair it with a paid method).
   */
  belowPrices: priceMap.optional(),
});

export const ShippingMethodSchema = z
  .discriminatedUnion('type', [FlatMethod, WeightTableMethod, PerItemMethod, FreeOverMethod])
  .refine((m) => m.estimatedDaysMax >= m.estimatedDaysMin, {
    message: 'estimatedDaysMax must be >= estimatedDaysMin',
    path: ['estimatedDaysMax'],
  });

export const ShippingZoneSchema = z
  .strictObject({
    id: z.string().min(1),
    name: z.string().optional(),
    /** Country list, or `'*'` for the catch-all zone. */
    countries: z.union([z.literal('*'), z.array(country).min(1)]),
    /**
     * Restrict to these regions (state codes) within `countries`. Region-restricted zones are the most specific.
     * Compared case-insensitively.
     */
    regions: z.array(region).min(1).optional(),
    /** May be empty: a zone with no methods deliberately blocks shipping to the places it matches. */
    methods: z.array(ShippingMethodSchema),
  })
  .superRefine((zone, ctx) => {
    if (zone.regions && zone.countries === '*')
      ctx.addIssue({
        code: 'custom',
        message: 'regions need an explicit country list',
        path: ['regions'],
      });
    const seen = new Set<string>();
    zone.methods.forEach((m, i) => {
      if (seen.has(m.id))
        ctx.addIssue({
          code: 'custom',
          message: `duplicate method id "${m.id}"`,
          path: ['methods', i, 'id'],
        });
      seen.add(m.id);
    });
  });

export const ShippingConfigSchema = z
  .strictObject({ zones: z.array(ShippingZoneSchema) })
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    cfg.zones.forEach((z, i) => {
      if (seen.has(z.id))
        ctx.addIssue({
          code: 'custom',
          message: `duplicate zone id "${z.id}"`,
          path: ['zones', i, 'id'],
        });
      seen.add(z.id);
    });
  });

export type ShippingMethodConfig = z.output<typeof ShippingMethodSchema>;
export type ShippingZoneConfig = z.output<typeof ShippingZoneSchema>;
export type ShippingConfig = z.output<typeof ShippingConfigSchema>;
export type ShippingConfigInput = z.input<typeof ShippingConfigSchema>;

/** Validate and normalise a shipping config. Throws a `ZodError` describing every problem. */
export function parseShippingConfig(input: unknown): ShippingConfig {
  return ShippingConfigSchema.parse(input);
}
