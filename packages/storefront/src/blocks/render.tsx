import type { ReactNode } from 'react';
import type { BlockNode, BlockRegistry } from '@sold/content';
import type { BlockContext } from '../contract';

type Renderer = (props: Record<string, unknown>) => ReactNode | Promise<ReactNode>;

/**
 * Render a validated block tree with the active theme's renderers. Each renderer loads lazily and only when used; an
 * unknown type (an extension disabled after the page was saved) renders nothing instead of breaking the page.
 */
export async function PageRenderer({
  tree,
  registry,
  ctx,
}: {
  tree: readonly BlockNode[];
  registry: BlockRegistry;
  ctx: BlockContext;
}): Promise<ReactNode> {
  const out: ReactNode[] = [];
  for (const node of tree) {
    const block = registry.get(node.type);
    if (!block) continue;
    const { default: Component } = (await block.def.component()) as { default: Renderer };
    const children = node.children?.length
      ? await PageRenderer({ tree: node.children, registry, ctx })
      : undefined;
    out.push(
      <Component key={node.id} {...node.props} ctx={ctx}>
        {children}
      </Component>,
    );
  }
  return <>{out}</>;
}
