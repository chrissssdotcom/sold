import { defineBlock, z } from '@sold/extension-sdk';
import { describe, expect, it } from 'vitest';
import { BlockRegistry } from './registry';
import type { InvalidTreeError } from './tree';
import { validateTree, walkTree } from './tree';

const component = async () => ({ default: () => null });
const hero = defineBlock({
  type: 'hero',
  title: 'Hero',
  propsSchema: z.object({
    heading: z.string().min(1).max(120),
    align: z.enum(['left', 'center']).default('left'),
  }),
  defaultProps: { heading: 'Hello' },
  component,
  thumbnail: 'data:,',
});
const columns = defineBlock({
  type: 'columns',
  title: 'Columns',
  propsSchema: z.object({ count: z.number().int().min(1).max(4).default(2) }),
  defaultProps: {},
  component,
  thumbnail: 'data:,',
});
const registry = new BlockRegistry().register(hero).register(columns, { container: true });

const issuesOf = (input: unknown, limits?: Parameters<typeof validateTree>[2]) => {
  try {
    validateTree(input, registry, limits);
    return [];
  } catch (e) {
    return (e as InvalidTreeError).issues;
  }
};

describe('validateTree', () => {
  it('accepts a valid tree and fills defaults from the block schema', () => {
    const tree = validateTree(
      [
        { id: 'a', type: 'hero', props: { heading: 'Hi' } },
        {
          id: 'b',
          type: 'columns',
          props: {},
          children: [{ id: 'c', type: 'hero', props: { heading: 'x' } }],
        },
      ],
      registry,
    );
    expect(tree[0]?.props).toEqual({ heading: 'Hi', align: 'left' });
    expect(tree[1]?.props).toEqual({ count: 2 });
    expect(tree[1]?.children?.[0]?.id).toBe('c');
  });

  it('reports every problem with a path, not just the first', () => {
    const issues = issuesOf([
      { id: 'a', type: 'nope', props: {} },
      { id: 'a', type: 'hero', props: { heading: '' } },
      {
        id: 'c',
        type: 'hero',
        props: { heading: 'ok' },
        children: [{ id: 'd', type: 'hero', props: { heading: 'x' } }],
      },
    ]);
    const text = issues.map((i) => `${i.path}: ${i.message}`).join('\n');
    expect(text).toContain('[0].type: Unknown block type "nope"');
    expect(text).toContain('[1].props.heading');
    expect(text).toContain('Duplicate block id "a"');
    expect(text).toContain('[2].children: "hero" cannot contain other blocks');
  });

  it('rejects non-arrays, malformed nodes and forbidden keys', () => {
    expect(issuesOf({})[0]?.message).toMatch(/list of blocks/);
    expect(issuesOf([{ type: 'hero', props: {} }]).length).toBeGreaterThan(0); // no id
    expect(issuesOf([{ id: 'bad id!', type: 'hero', props: {} }]).length).toBeGreaterThan(0);
    const proto = JSON.parse(
      '[{"id":"a","type":"hero","props":{"heading":"x","__proto__":{"polluted":true}}}]',
    );
    expect(issuesOf(proto).some((i) => /Forbidden/.test(i.message))).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('enforces depth, node count and size limits', () => {
    const nest = (d: number): unknown[] =>
      d === 0
        ? [{ id: `leaf`, type: 'hero', props: { heading: 'x' } }]
        : [{ id: `n${d}`, type: 'columns', props: {}, children: nest(d - 1) }];
    expect(issuesOf(nest(3))).toEqual([]);
    expect(issuesOf(nest(8)).some((i) => /Nesting deeper/.test(i.message))).toBe(true);
    const many = Array.from({ length: 50 }, (_, i) => ({
      id: `h${i}`,
      type: 'hero',
      props: { heading: 'x' },
    }));
    expect(
      issuesOf(many, { maxDepth: 6, maxNodes: 10, maxBytes: 1e6 }).some((i) =>
        /More than 10 blocks/.test(i.message),
      ),
    ).toBe(true);
    expect(issuesOf(many, { maxDepth: 6, maxNodes: 100, maxBytes: 100 })[0]?.message).toMatch(
      /too large/,
    );
  });

  it('walkTree visits every node depth-first', () => {
    const tree = validateTree(
      [
        {
          id: 'a',
          type: 'columns',
          props: {},
          children: [{ id: 'b', type: 'hero', props: { heading: 'x' } }],
        },
        { id: 'c', type: 'hero', props: { heading: 'y' } },
      ],
      registry,
    );
    const seen: string[] = [];
    walkTree(tree, (n) => seen.push(n.id));
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('registry refuses duplicate and malformed types', () => {
    expect(() => new BlockRegistry().register(hero).register(hero)).toThrow(/Duplicate/);
    expect(() => new BlockRegistry().register({ ...hero, type: 'Bad Type' })).toThrow(/Invalid/);
    expect(() =>
      new BlockRegistry().register({ ...hero, type: 'loyalty-points/banner' }),
    ).not.toThrow();
  });
});
