import type { SoldConfigInput } from '@sold/core/config';

/**
 * prod overrides, merged over `sold.config.ts` by the config loader (PENDING(phase-1)).
 * Customer-owned. Keep environment differences here (data), never in code paths.
 * Production: enable the waiting room only for scheduled events (`scale.waitingRoom`).
 */
const overrides: Partial<SoldConfigInput> = {};

export default overrides;
