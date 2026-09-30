import { z } from '@sold/extension-sdk';

/** Settings become an admin form automatically; `crmApiToken` is stored encrypted and never shown again. */
export const settings = z.object({
  pointsPerDollar: z.number().int().min(1).max(100).default(1).meta({ title: 'Points per dollar' }),
  maxQuantityPerLine: z.number().int().min(1).max(1000).default(10).meta({
    title: 'Max quantity per cart line',
    description: 'Drop rule enforced while adding to the cart.',
  }),
  crmApiToken: z
    .string()
    .min(8)
    .optional()
    .meta({ title: 'CRM API token', description: 'Optional. Stored encrypted.' }),
});

export type Settings = z.output<typeof settings>;
