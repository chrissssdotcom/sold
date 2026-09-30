import type { SoldConfigInput } from '@sold/core/config';

/**
 * {{environment}} overrides, merged over `sold.config.ts` by the config loader (PENDING(phase-1)).
 * Customer-owned. Keep environment differences here (data), never in code paths.
{{overlay_note}}
 */
const overrides: Partial<SoldConfigInput> = {};

export default overrides;
