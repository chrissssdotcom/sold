import { describe, expect, it } from 'vitest';
import type { ComponentType } from 'react';
import { validateTree } from '@sold/content';
import { defineTheme, type ThemeComponents } from '../contract';
import { baseBlockMeta } from './definitions';
import { createBlockRegistry, createSchemaRegistry } from './registry';

const C = (() => null) as ComponentType<never>;
const components = Object.fromEntries(
  [
    'Announcement',
    'Header',
    'Footer',
    'CartDrawer',
    'ProductCard',
    'HomeFallback',
    'ProductListPage',
    'ProductDetailPage',
    'CartPage',
    'CheckoutPage',
    'OrderPage',
    'NotFoundPage',
    'AuthPage',
    'AccountPage',
  ].map((k) => [k, C]),
) as unknown as ThemeComponents;
const blocks = Object.fromEntries(baseBlockMeta.map((m) => [m.type, (() => m.type) as never]));

describe('block registries', () => {
  it('the schema registry knows every Base block type and validates pages without any theme', () => {
    const r = createSchemaRegistry();
    expect(
      r
        .list()
        .map((b) => b.def.type)
        .sort(),
    ).toEqual(baseBlockMeta.map((m) => m.type).sort());
    expect(() =>
      validateTree([{ id: 'a', type: 'hero', props: { heading: 'Hi' } }], r),
    ).not.toThrow();
    expect(() => validateTree([{ id: 'a', type: 'hero', props: {} }], r)).toThrow();
  });

  it("a theme registry serves the theme's renderer, and a child override replaces just that type", async () => {
    const base = defineTheme({ name: 'base', components, blocks });
    const override = (() => 'override') as never;
    const child = defineTheme({ name: 'child', extends: base, blocks: { hero: override } });
    const hero = createBlockRegistry(child).get('hero');
    expect(((await hero?.def.component()) as { default: unknown }).default).toBe(override);
    const spacer = createBlockRegistry(child).get('spacer');
    expect(((await spacer?.def.component()) as { default: unknown }).default).toBe(
      base.blocks['spacer'],
    );
  });

  it('columns is the only container; a theme missing a renderer fails at build', () => {
    const r = createSchemaRegistry();
    expect(
      r
        .list()
        .filter((b) => b.container)
        .map((b) => b.def.type),
    ).toEqual(['columns']);
    const incomplete = defineTheme({
      name: 'inc',
      components,
      blocks: { hero: (() => null) as never },
    });
    expect(() => createBlockRegistry(incomplete)).toThrow(/no renderer for block/);
  });
});
