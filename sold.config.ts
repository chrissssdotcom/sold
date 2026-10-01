import { defineConfig } from '@sold/core/config';

/**
 * Instance configuration. Customer-owned: this file (and `config/<env>.ts`, `extensions/`)
 * is where an instance is customised. Base never edits it after `customer:new`.
 */
export default defineConfig({
  instance: { name: 'Sold Demo Store', customer: 'demo' },
  tier: 'standard',
  currencies: {
    base: 'AUD',
    enabled: [
      { code: 'AUD' },
      { code: 'USD', strategy: 'derived', rounding: '.99' },
      { code: 'JPY', strategy: 'fixed' },
    ],
  },
  locales: { default: 'en-AU', enabled: ['en-AU', 'en-US'] },
  // Worked example shipped with Base (docs/extending.md). Remove it to run the demo store with zero extensions.
  extensions: ['loyalty-points', 'reviews', 'tiktok-social'],
  gateways: { enabled: ['manual'] },
});
