import { createBlockRegistry } from '@sold/storefront/blocks';
import type { Theme } from '@sold/storefront';
import activeTheme from '../../.generated/theme';
import { extensionBlockDefs } from '../server/extension-ui';

/** The theme selected by `theme.preset` in sold.config.ts (generated at build: see scripts/sync-theme.ts). */
export const theme: Theme = activeTheme;

let registry: ReturnType<typeof createBlockRegistry> | undefined;
/** Page-builder blocks for the active theme: Base block types rendered by the theme, plus its extra blocks. */
export function blockRegistry() {
  registry ??= createBlockRegistry(theme, extensionBlockDefs());
  return registry;
}
