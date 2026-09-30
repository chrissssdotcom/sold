import { parseTaxTable, type TaxRuleInput } from './schema';

/**
 * Default tax tables.
 *
 * ILLUSTRATIVE EXAMPLES ONLY. These rates are a starting point for development, demos and tests. They are NOT
 * legal or tax advice, may be out of date or incomplete (thresholds, registration, product-specific rules, local
 * rates and rate changes are not modelled), and MUST be reviewed by a qualified tax adviser, or replaced by a
 * dedicated tax provider extension, before you charge real customers.
 *
 * Categories: `standard` (also the fallback for unknown categories), `reduced`, `zero`, `exempt`
 * (`exempt` is untaxed even without an explicit rule).
 */

/** Australia: GST 10% on goods and shipping; `exempt` (GST-free) 0%. */
export const AU_TAX_RULES: readonly TaxRuleInput[] = [
  { country: 'AU', category: 'standard', name: 'GST', rateBps: 1000, appliesToShipping: true },
  { country: 'AU', category: 'exempt', name: 'GST-free', rateBps: 0, appliesToShipping: false },
];

/** New Zealand: GST 15%. */
export const NZ_TAX_RULES: readonly TaxRuleInput[] = [
  { country: 'NZ', category: 'standard', name: 'GST', rateBps: 1500, appliesToShipping: true },
  { country: 'NZ', category: 'exempt', name: 'GST-free', rateBps: 0, appliesToShipping: false },
];

/** United Kingdom: VAT 20% standard, 5% `reduced`, 0% `zero` (zero-rated). */
export const GB_TAX_RULES: readonly TaxRuleInput[] = [
  { country: 'GB', category: 'standard', name: 'VAT', rateBps: 2000, appliesToShipping: true },
  { country: 'GB', category: 'reduced', name: 'VAT', rateBps: 500, appliesToShipping: false },
  { country: 'GB', category: 'zero', name: 'VAT zero-rated', rateBps: 0, appliesToShipping: false },
];

/** Japan: consumption tax 10% standard, 8% `reduced` (zero decimals in JPY: exercises exponent 0). */
export const JP_TAX_RULES: readonly TaxRuleInput[] = [
  {
    country: 'JP',
    category: 'standard',
    name: 'Consumption tax',
    rateBps: 1000,
    appliesToShipping: true,
  },
  {
    country: 'JP',
    category: 'reduced',
    name: 'Consumption tax (reduced)',
    rateBps: 800,
    appliesToShipping: false,
  },
];

/**
 * United States: a tiny, illustrative sales-tax example. Real US sales tax is mostly destination-based with
 * thousands of local jurisdictions, product taxability rules and economic-nexus thresholds; this table instead uses
 * ORIGIN-based sourcing (the seller's state decides the rate, for domestic sales only) purely as a simplification,
 * and covers only a few states. Shipping is untaxed here. Do not use for real filings; use a tax service extension.
 */
export const US_ILLUSTRATIVE_TAX_RULES: readonly TaxRuleInput[] = (
  [
    ['CA', 'CA state sales tax', 725],
    ['TX', 'TX state sales tax', 625],
    ['FL', 'FL state sales tax', 600],
    ['WA', 'WA state sales tax', 650],
    ['NY', 'NY state sales tax', 400],
    // A second component in the same jurisdiction, to show summed state + local rates.
    ['NY', 'NY local sales tax (example)', 450],
  ] as const
).map(([region, name, rateBps]) => ({
  country: 'US',
  region,
  category: 'standard',
  name,
  rateBps,
  appliesToShipping: false,
  sourcing: 'origin' as const,
}));

/** Disclaimer to surface wherever the default tables are documented or configured. */
export const TAX_TABLES_DISCLAIMER =
  'The bundled tax tables are illustrative examples, not legal or tax advice. Review them with a qualified adviser before use.';

/** All bundled example rules, validated at module load. */
export const defaultTaxTable = parseTaxTable({
  rules: [
    ...AU_TAX_RULES,
    ...NZ_TAX_RULES,
    ...GB_TAX_RULES,
    ...JP_TAX_RULES,
    ...US_ILLUSTRATIVE_TAX_RULES,
  ],
});
