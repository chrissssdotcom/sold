import { parseShippingConfig, type ShippingConfigInput } from './schema';

/**
 * Example shipping configuration for development and demos. Prices, carriers and delivery estimates are
 * ILLUSTRATIVE: every store must supply its own `ShippingConfig`. Currencies without a price on a method make that
 * method unavailable (nothing is converted), so a store selling in another currency must add its prices.
 */
export const exampleShippingConfig: ShippingConfigInput = {
  zones: [
    {
      // Most specific: remote regions of Australia cost more than the rest of the country.
      id: 'au-remote',
      name: 'Australia - remote (TAS, NT)',
      countries: ['AU'],
      regions: ['TAS', 'NT'],
      methods: [
        {
          id: 'standard',
          type: 'flat',
          label: 'Standard (remote)',
          prices: { AUD: '19.95' },
          estimatedDaysMin: 5,
          estimatedDaysMax: 10,
        },
      ],
    },
    {
      id: 'au',
      name: 'Australia',
      countries: ['AU'],
      methods: [
        {
          id: 'standard',
          type: 'free_over',
          label: 'Standard',
          threshold: { AUD: '150.00' },
          belowPrices: { AUD: '9.95' },
          estimatedDaysMin: 3,
          estimatedDaysMax: 7,
        },
        {
          id: 'express',
          type: 'flat',
          label: 'Express',
          prices: { AUD: '15.95' },
          estimatedDaysMin: 1,
          estimatedDaysMax: 3,
          promoEligible: false,
        },
      ],
    },
    {
      id: 'nz',
      name: 'New Zealand',
      countries: ['NZ'],
      methods: [
        {
          id: 'standard',
          type: 'weight_table',
          label: 'Standard',
          tiers: [
            { maxGrams: 500, prices: { AUD: '14.95', NZD: '16.95' } },
            { maxGrams: 2000, prices: { AUD: '19.95', NZD: '22.95' } },
            { maxGrams: 5000, prices: { AUD: '29.95', NZD: '32.95' } },
          ],
          estimatedDaysMin: 4,
          estimatedDaysMax: 8,
        },
      ],
    },
    {
      id: 'world',
      name: 'Rest of world',
      countries: '*',
      methods: [
        {
          id: 'intl-standard',
          type: 'weight_table',
          label: 'International standard',
          tiers: [
            { maxGrams: 500, prices: { AUD: '24.95', USD: '16.00', JPY: '2400' } },
            { maxGrams: 2000, prices: { AUD: '39.95', USD: '26.00', JPY: '3900' } },
            { maxGrams: null, prices: { AUD: '59.95', USD: '39.00', JPY: '5900' } },
          ],
          estimatedDaysMin: 7,
          estimatedDaysMax: 21,
        },
      ],
    },
  ],
};

/** The example config, validated at module load. */
export const defaultShippingConfig = parseShippingConfig(exampleShippingConfig);
