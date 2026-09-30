import { z } from 'zod';
import type { BlockRegistry } from './registry';

export interface BlockNode {
  id: string;
  type: string;
  props: Record<string, unknown>;
  children?: BlockNode[];
}

export interface TreeLimits {
  maxDepth: number;
  maxNodes: number;
  /** Serialised size cap, bytes. Bounds what one save can write and what one render must parse. */
  maxBytes: number;
}

export const defaultTreeLimits: TreeLimits = { maxDepth: 6, maxNodes: 400, maxBytes: 256 * 1024 };

export interface TreeIssue {
  path: string;
  message: string;
}

export class InvalidTreeError extends Error {
  readonly code = 'invalid_page_tree';
  constructor(readonly issues: TreeIssue[]) {
    super(
      `Invalid page: ${issues[0]?.message ?? 'unknown'} (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
    );
    this.name = 'InvalidTreeError';
  }
}

const nodeShape = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  type: z.string().min(1).max(80),
  props: z.record(z.string(), z.unknown()).default({}),
  children: z.array(z.unknown()).optional(),
});

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Validate a block tree against the registry and return it with each block's props parsed (defaults applied, unknown
 * keys per the block's own schema). Nothing partial is ever returned: any issue throws `InvalidTreeError` listing all
 * of them, so an editor can highlight every problem at once.
 */
export function validateTree(
  input: unknown,
  registry: BlockRegistry,
  limits: TreeLimits = defaultTreeLimits,
): BlockNode[] {
  const issues: TreeIssue[] = [];
  if (!Array.isArray(input))
    throw new InvalidTreeError([{ path: '', message: 'A page is a list of blocks' }]);
  const bytes = Buffer.byteLength(JSON.stringify(input));
  if (bytes > limits.maxBytes)
    throw new InvalidTreeError([
      { path: '', message: `Page is too large (${bytes} > ${limits.maxBytes} bytes)` },
    ]);

  const ids = new Set<string>();
  let count = 0;

  const walk = (nodes: unknown[], path: string, depth: number): BlockNode[] => {
    const out: BlockNode[] = [];
    nodes.forEach((raw, i) => {
      const at = `${path}[${i}]`;
      if (++count > limits.maxNodes) {
        if (count === limits.maxNodes + 1)
          issues.push({ path: at, message: `More than ${limits.maxNodes} blocks on one page` });
        return;
      }
      // Scan the RAW props: a schema parse may silently drop these keys, hiding the attempt.
      const rawProps = (raw as { props?: unknown } | null)?.props;
      if (rawProps && typeof rawProps === 'object')
        for (const key of Object.keys(rawProps))
          if (FORBIDDEN_KEYS.has(key))
            issues.push({ path: `${at}.props.${key}`, message: 'Forbidden property name' });
      const shape = nodeShape.safeParse(raw);
      if (!shape.success) {
        for (const iss of shape.error.issues)
          issues.push({ path: `${at}.${iss.path.join('.')}`, message: iss.message });
        return;
      }
      const node = shape.data;
      if (ids.has(node.id))
        issues.push({ path: `${at}.id`, message: `Duplicate block id "${node.id}"` });
      ids.add(node.id);
      for (const key of Object.keys(node.props))
        if (FORBIDDEN_KEYS.has(key))
          issues.push({ path: `${at}.props.${key}`, message: 'Forbidden property name' });

      const block = registry.get(node.type);
      if (!block) {
        issues.push({ path: `${at}.type`, message: `Unknown block type "${node.type}"` });
        return;
      }
      const parsed = block.def.propsSchema.safeParse(node.props);
      if (!parsed.success) {
        for (const iss of parsed.error.issues)
          issues.push({ path: `${at}.props.${iss.path.join('.')}`, message: iss.message });
        return;
      }
      const result: BlockNode = {
        id: node.id,
        type: node.type,
        props: parsed.data as Record<string, unknown>,
      };
      if (node.children && node.children.length > 0) {
        if (!block.container) {
          issues.push({
            path: `${at}.children`,
            message: `"${node.type}" cannot contain other blocks`,
          });
        } else if (depth + 1 >= limits.maxDepth) {
          issues.push({
            path: `${at}.children`,
            message: `Nesting deeper than ${limits.maxDepth} levels`,
          });
        } else {
          result.children = walk(node.children, `${at}.children`, depth + 1);
        }
      }
      out.push(result);
    });
    return out;
  };

  const tree = walk(input, '', 0);
  if (issues.length > 0) throw new InvalidTreeError(issues);
  return tree;
}

/** Depth-first visit, for renderers that batch data needs (e.g. one query for every product grid on a page). */
export function walkTree(tree: readonly BlockNode[], visit: (node: BlockNode) => void): void {
  for (const node of tree) {
    visit(node);
    if (node.children) walkTree(node.children, visit);
  }
}
