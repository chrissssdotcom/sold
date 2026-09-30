import { z } from 'zod';

/**
 * Tax tables are configuration and therefore validated with Zod at the boundary.
 *
 * IMPORTANT: the tables shipped in `tables.ts` are illustrative examples for development and demos.
 * They are NOT legal or tax advice and must be reviewed by a qualified adviser before use in production.
 */

const country = z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 code, upper case');
const region = z
  .string()
  .trim()
  .min(1)
  .transform((s) => s.toUpperCase());
const category = z.string().regex(/^[a-z][a-z0-9_-]*$/, 'lower-case category id');
/** ISO-8601 instant or calendar date (a bare date means 00:00:00Z of that day). */
const instant = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);

export const TaxRuleSchema = z
  .strictObject({
    country,
    /** Region/state code. Omitted = the whole country. Compared case-insensitively. */
    region: region.optional(),
    /** Tax category the rule applies to. `standard` is also the fallback for unlisted categories. */
    category,
    /** Human label shown on invoices, e.g. `GST`. */
    name: z.string().min(1),
    /** Rate in basis points (integer): 1000 = 10%. 0 is valid (zero-rated). */
    rateBps: z.number().int().min(0).max(10_000),
    /** Explicit on purpose: whether this component is charged on the shipping amount. */
    appliesToShipping: z.boolean(),
    /**
     * `destination` (default): the rule applies when the buyer is in `country`/`region`.
     * `origin`: the rule applies when the SELLER is in `country`/`region` and the buyer is in the same country
     * (origin-based sourcing, a simplification of how some US states work).
     */
    sourcing: z.enum(['destination', 'origin']).default('destination'),
    /** Inclusive start of validity. */
    effectiveFrom: instant.optional(),
    /** Exclusive end of validity. */
    effectiveTo: instant.optional(),
  })
  .refine(
    (r) =>
      r.effectiveFrom === undefined ||
      r.effectiveTo === undefined ||
      Date.parse(r.effectiveFrom) < Date.parse(r.effectiveTo),
    { message: 'effectiveTo must be after effectiveFrom', path: ['effectiveTo'] },
  );

export const TaxTableSchema = z.strictObject({ rules: z.array(TaxRuleSchema) });

export type TaxRule = z.output<typeof TaxRuleSchema>;
export type TaxRuleInput = z.input<typeof TaxRuleSchema>;
export type TaxTable = z.output<typeof TaxTableSchema>;
export type TaxTableInput = z.input<typeof TaxTableSchema>;

/** Validate and normalise a tax table. Throws a `ZodError` describing every problem. */
export function parseTaxTable(input: unknown): TaxTable {
  return TaxTableSchema.parse(input);
}
