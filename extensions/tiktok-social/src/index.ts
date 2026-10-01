import { defineBlock, defineExtension, z } from '@sold/extension-sdk';
import { publicConfig } from './config.route';
import { paymentEvent, placeOrderEvent } from './server-events.observer';
import { settings } from './settings';

const thumb = (label: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" rx="10" fill="#111"/><text x="80" y="55" text-anchor="middle" font-family="sans-serif" font-size="13" fill="#fff">${label}</text></svg>`)}`;

/**
 * TikTok: consent-gated browser pixel, server-side Events API conversions, and two page-builder blocks.
 * Everything that talks to TikTok (pixel, Events API, embeds) respects the customer's recorded cookie choice.
 */
export default defineExtension({
  name: 'tiktok-social',
  version: '0.1.0',
  description: 'TikTok pixel and Events API (consent-gated), plus follow and video blocks.',
  requires: { base: '^0.1.0' },
  performance: { hotPath: false },
  migrations: { dir: 'migrations' },
  settings: { schema: settings, secrets: ['accessToken'] },
  observers: [placeOrderEvent, paymentEvent],
  routes: [publicConfig],
  slots: [
    {
      slot: 'storefront.footer',
      id: 'tiktok-pixel',
      component: () => import('./tiktok-pixel.client'),
    },
  ],
  blocks: [
    defineBlock({
      type: 'follow-banner',
      title: 'TikTok follow banner',
      category: 'Social',
      propsSchema: z.object({
        handle: z
          .string()
          .regex(/^[A-Za-z0-9._-]{1,24}$/, 'TikTok handle without the @')
          .meta({ title: 'Handle' }),
        heading: z.string().max(80).default('See it on TikTok').meta({ title: 'Heading' }),
      }),
      defaultProps: { handle: 'tiktok', heading: 'See it on TikTok' },
      component: () => import('./follow-banner.block'),
      thumbnail: thumb('Follow'),
    }),
    defineBlock({
      type: 'video-embed',
      title: 'TikTok video',
      category: 'Social',
      propsSchema: z.object({
        url: z
          .string()
          .regex(
            /^https:\/\/www\.tiktok\.com\/@[A-Za-z0-9._-]+\/video\/\d{6,25}$/,
            'a TikTok video URL',
          )
          .meta({ title: 'Video URL' }),
      }),
      defaultProps: { url: 'https://www.tiktok.com/@tiktok/video/7000000000000000000' },
      component: () => import('./video-embed.block'),
      thumbnail: thumb('Video'),
    }),
  ],
});
