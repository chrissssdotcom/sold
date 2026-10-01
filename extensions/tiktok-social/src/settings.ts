import { z } from '@sold/extension-sdk';

export const settings = z.object({
  pixelCode: z
    .string()
    .regex(/^[A-Z0-9]{8,32}$/, 'Letters and digits, as shown in TikTok Events Manager')
    .optional()
    .meta({
      title: 'Pixel code',
      description:
        "Events Manager > Web events. Public identifier. Leave blank to disable tracking. The site's Content-Security-Policy must also allow https://analytics.tiktok.com (see docs/social-growth.md).",
    }),
  serverEvents: z.boolean().default(false).meta({
    title: 'Send conversions from the server (Events API)',
    description:
      'Needs the access token below. Only orders whose customer accepted advertising cookies are ever sent.',
  }),
  accessToken: z
    .string()
    .min(8)
    .optional()
    .meta({ title: 'Events API access token', description: 'Stored encrypted.' }),
  testEventCode: z.string().max(40).optional().meta({
    title: 'Test event code',
    description: 'Set while testing in Events Manager; clear for production.',
  }),
  apiBase: z
    .url()
    .default('https://business-api.tiktok.com')
    .meta({ title: 'Events API base URL' }),
  publicUrl: z.url().optional().meta({
    title: 'Store URL',
    description: 'Sent as the event page URL, e.g. https://shop.example.com',
  }),
});

export type Settings = z.output<typeof settings>;
