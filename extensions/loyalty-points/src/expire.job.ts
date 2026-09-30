import { defineJob, z, type ExtensionContext } from '@sold/extension-sdk';

/** Background jobs live in `*.job.ts` files. Bulk work belongs in a job, never on a request. */
export const expireJob = defineJob({
  queue: 'expire',
  class: 'bulk',
  dataSchema: z.object({ olderThanDays: z.number().int().positive().default(365) }),
  handler: async ({ data }, ctx: ExtensionContext) => {
    // Reads its own tables only.
    ctx.log.info({ olderThanDays: data.olderThanDays }, 'expiry sweep (no-op in the example)');
  },
});
