import type { SoldConfigInput } from '@sold/core/config';

/**
 * dev overrides, merged over `sold.config.ts` by the config loader (PENDING(phase-1)).
 * Customer-owned. Keep environment differences here (data), never in code paths.
 * Dev is the shared integration environment; non-production safety switches are applied by profile.
 */
const overrides: Partial<SoldConfigInput> = {};

export default overrides;
