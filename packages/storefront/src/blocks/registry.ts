import { BlockRegistry } from '@sold/content';
import { defineBlock, type BlockDefinition } from '@sold/extension-sdk';
import type { Theme } from '../contract';
import { baseBlockMeta } from './definitions';

const thumb = (label: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" rx="10" fill="#f2ebe0"/><text x="80" y="55" text-anchor="middle" font-family="sans-serif" font-size="13" fill="#6a6056">${label}</text></svg>`)}`;

/**
 * Build the block registry for a theme: Base block types, whose renderers come from the theme (child overrides win),
 * plus the theme's extra blocks and any extension-contributed blocks. A missing renderer is a build-time error.
 */
export function createBlockRegistry(
  theme: Theme,
  extensionBlocks: readonly BlockDefinition[] = [],
): BlockRegistry {
  const registry = new BlockRegistry();
  for (const meta of baseBlockMeta) {
    const Component = theme.blocks[meta.type];
    if (!Component)
      throw new Error(`Theme "${theme.name}" has no renderer for block "${meta.type}"`);
    registry.register(
      defineBlock({
        type: meta.type,
        title: meta.title,
        category: meta.category,
        propsSchema: meta.propsSchema as never,
        defaultProps: meta.defaultProps as never,
        component: (async () => ({ default: Component })) as never,
        thumbnail: thumb(meta.title),
      }),
      { container: meta.container ?? false },
    );
  }
  for (const b of [...theme.extraBlocks, ...extensionBlocks]) registry.register(b);
  return registry;
}

/**
 * A registry for tooling that only VALIDATES pages (seed scripts, the admin API, the CLI): same block types and schemas,
 * no renderers, so it can run in plain Node without loading any theme (themes import CSS, which only bundlers can).
 */
export function createSchemaRegistry(
  extensionBlocks: readonly BlockDefinition[] = [],
): BlockRegistry {
  const registry = new BlockRegistry();
  const none = (async () => ({ default: () => null })) as never;
  for (const meta of baseBlockMeta)
    registry.register(
      defineBlock({
        type: meta.type,
        title: meta.title,
        category: meta.category,
        propsSchema: meta.propsSchema as never,
        defaultProps: meta.defaultProps as never,
        component: none,
        thumbnail: thumb(meta.title),
      }),
      { container: meta.container ?? false },
    );
  for (const b of extensionBlocks) registry.register(b);
  return registry;
}
