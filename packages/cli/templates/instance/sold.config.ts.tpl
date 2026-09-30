import { defineConfig } from '@sold/core/config';

/**
 * Instance configuration for {{name}}. Customer-owned: this file (and `config/<env>.ts`, `extensions/`)
 * is where the instance is customised. Base never edits it after `customer:new`.
 */
export default defineConfig({
  instance: { name: '{{name}}', customer: '{{customer}}' },
  tier: 'standard',
  currencies: {
    base: 'AUD',
    enabled: [{ code: 'AUD' }],
  },
  locales: { default: 'en-AU', enabled: ['en-AU'] },
  extensions: [],
  gateways: { enabled: ['manual'] },
});
