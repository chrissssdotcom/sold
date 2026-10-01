import { z } from '@sold/extension-sdk';

export const settings = z.object({
  autoApprove: z.boolean().default(false).meta({
    title: 'Publish reviews without moderation',
    description:
      'Off (recommended): every new or edited review waits in the moderation queue. On: verified-buyer reviews go live immediately.',
  }),
});

export type Settings = z.output<typeof settings>;
