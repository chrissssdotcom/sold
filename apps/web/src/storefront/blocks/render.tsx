import type { ReactNode } from 'react';
import type { BlockNode } from '@sold/content';
import type { Market } from '../lib/i18n';
import { baseRegistry } from './registry';

/**
 * Render a validated block tree. Each block type is loaded lazily and only when used; an unknown type (an extension that
 * was disabled after the page was saved) renders nothing instead of breaking the page.
 */
export async function PageRenderer({
  tree,
  market,
}: {
  tree: readonly BlockNode[];
  market: Market;
}): Promise<ReactNode> {
  const registry = baseRegistry();
  const out: ReactNode[] = [];
  for (const node of tree) {
    const block = registry.get(node.type);
    if (!block) continue;
    const { default: Component } = (await block.def.component()) as {
      default: (props: Record<string, unknown>) => ReactNode;
    };
    const children = node.children?.length
      ? await PageRenderer({ tree: node.children, market })
      : undefined;
    out.push(
      <Component key={node.id} {...node.props} market={market}>
        {children}
      </Component>,
    );
  }
  return <>{out}</>;
}
