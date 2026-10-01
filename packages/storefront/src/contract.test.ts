import { describe, expect, it } from 'vitest';
import type { ComponentType } from 'react';
import {
  ThemeError,
  darkTokensCss,
  defineTheme,
  validateTokens,
  type ThemeComponents,
} from './contract';

const C = (() => null) as ComponentType<never>;
const full: ThemeComponents = {
  Announcement: C,
  Header: C,
  Footer: C,
  CartDrawer: C,
  ProductCard: C,
  HomeFallback: C,
  ProductListPage: C,
  ProductDetailPage: C,
  CartPage: C,
  CheckoutPage: C,
  OrderPage: C,
  NotFoundPage: C,
  AuthPage: C,
  AccountPage: C,
} as unknown as ThemeComponents;
const base = defineTheme({
  name: 'base',
  components: full,
  tokens: { '--accent': '#111' },
  blocks: { hero: (() => 'base-hero') as never },
});

describe('defineTheme', () => {
  it('a child inherits everything and overrides only what it lists', () => {
    const Footer = (() => null) as never;
    const child = defineTheme({
      name: 'child',
      extends: base,
      components: { Footer },
      tokens: { '--bg': '#fff' },
    });
    expect(child.components.Footer).toBe(Footer);
    expect(child.components.Header).toBe(base.components.Header);
    expect(child.tokens).toEqual({ '--accent': '#111', '--bg': '#fff' });
    expect(child.blocks['hero']).toBe(base.blocks['hero']);
    expect(child.lineage).toEqual(['base', 'child']);
  });

  it('chains: grandchild wins over child wins over parent', () => {
    const a = defineTheme({ name: 'a', extends: base, tokens: { '--accent': 'red' } });
    const b = defineTheme({ name: 'b', extends: a, tokens: { '--accent': 'blue' } });
    expect(b.tokens['--accent']).toBe('blue');
    expect(b.lineage).toEqual(['base', 'a', 'b']);
  });

  it('block renderers are overridable by type and extra blocks accumulate without duplicates', () => {
    const hero = (() => 'x') as never;
    expect(defineTheme({ name: 'c', extends: base, blocks: { hero } }).blocks['hero']).toBe(hero);
    const extra = (type: string) => ({
      type,
      title: type,
      propsSchema: {} as never,
      defaultProps: {},
      component: (async () => ({ default: C })) as never,
      thumbnail: '',
    });
    const withExtra = defineTheme({ name: 'd', extends: base, extraBlocks: [extra('promo')] });
    expect(
      defineTheme({ name: 'e', extends: withExtra, extraBlocks: [extra('other')] }).extraBlocks.map(
        (b) => b.type,
      ),
    ).toEqual(['promo', 'other']);
    expect(() =>
      defineTheme({ name: 'f', extends: withExtra, extraBlocks: [extra('promo')] }),
    ).toThrow(/twice/);
  });

  it('refuses a theme that lacks components, or a bad name', () => {
    expect(() => defineTheme({ name: 'x', components: { Header: C } as never })).toThrow(
      /missing components/,
    );
    expect(() => defineTheme({ name: 'x' })).toThrow(ThemeError);
    for (const name of ['Bad', '1x', 'a b', ''])
      expect(() => defineTheme({ name, extends: base })).toThrow(/Invalid theme name/);
  });

  it('the resolved theme is frozen', () => {
    expect(Object.isFrozen(base)).toBe(true);
    expect(() => ((base.tokens as Record<string, string>)['--x'] = '1')).toThrow();
  });
});

describe('design token validation (tokens become CSS, so values must not escape a declaration)', () => {
  it('accepts normal tokens', () => {
    expect(() =>
      validateTokens(
        {
          '--accent': '#a94a22',
          '--font-body': "'Inter Variable', system-ui, sans-serif",
          '--shadow-sm': '0 1px 2px rgb(60 40 20 / 0.06)',
          '--r-md': '16px',
          '--ease': 'cubic-bezier(0.22, 1, 0.36, 1)',
        },
        't',
      ),
    ).not.toThrow();
  });

  it.each([
    ['name without --', { accent: 'red' }],
    ['uppercase name', { '--Accent': 'red' }],
    ['semicolon', { '--a': 'red; background: url(x)' }],
    ['brace', { '--a': 'red} body{display:none' }],
    ['angle bracket', { '--a': '</style><script>' }],
    ['url()', { '--a': 'url(https://evil)' }],
    ['@import', { '--a': '@import foo' }],
    ['backslash escape', { '--a': 'red\\3b' }],
    ['expression()', { '--a': 'expression(alert(1))' }],
    ['too long', { '--a': 'x'.repeat(300) }],
    ['empty', { '--a': '' }],
  ])('rejects %s', (_n, tokens) => {
    expect(() => validateTokens(tokens as Record<string, string>, 't')).toThrow(ThemeError);
  });

  it('dark tokens render a media-query block, empty when none', () => {
    expect(darkTokensCss({ darkTokens: {} })).toBe('');
    expect(darkTokensCss({ darkTokens: { '--bg': '#000' } })).toContain('--bg:#000;');
    expect(() => defineTheme({ name: 'z', extends: base, darkTokens: { '--bg': 'x;y' } })).toThrow(
      ThemeError,
    );
  });
});
