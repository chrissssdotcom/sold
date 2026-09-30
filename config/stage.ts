import type { SoldConfigInput } from '@sold/core/config';

/**
 * stage overrides, merged over `sold.config.ts` by the config loader (PENDING(phase-1)).
 * Customer-owned. Keep environment differences here (data), never in code paths.
 * Stage mirrors production shape; keep differences minimal so load tests stay meaningful.
 */
const overrides: Partial<SoldConfigInput> = {};

export default overrides;
