import type { ComponentType, ReactNode } from 'react';
import type { CatalogProduct, OrderView } from '@sold/commerce';
import type { BlockDefinition } from '@sold/extension-sdk';
import type { Market } from './kit/i18n';

/**
 * The storefront contract. Pages, layout and blocks are all *components a theme supplies*; Base owns the data, routing,
 * caching and security, and hands each component plain props. Replace any part, keep the rest.
 *
 *   defineTheme({ extends: defaultTheme, tokens: { '--accent': '#0a7' }, components: { Footer: MyFooter } })
 */

export type StockMap = ReadonlyMap<string, { available: number | null }>;

/** Everything a server component may need to read. Implemented by the app over the replica; never a database handle. */
export interface StorefrontData {
  products(limit: number): Promise<CatalogProduct[]>;
  productsByHandles(handles: readonly string[]): Promise<CatalogProduct[]>;
  availability(variantIds: readonly string[]): Promise<StockMap>;
}

export interface SiteInfo {
  name: string;
}

export interface ChromeProps {
  market: Market;
  site: SiteInfo;
}

export interface ProductCardProps {
  product: CatalogProduct;
  market: Market;
  soldOut?: boolean;
  /** Above the fold: load eagerly. */
  priority?: boolean;
}

export interface ProductListPageProps {
  market: Market;
  /** The resolved theme, so a page template renders the theme's own components (ProductCard, ...). */
  theme: Theme;
  products: CatalogProduct[];
  stock: StockMap;
}

export interface ProductDetailPageProps {
  market: Market;
  theme: Theme;
  product: CatalogProduct;
  stock: StockMap;
  related: CatalogProduct[];
  relatedStock: StockMap;
}

export interface OrderPageProps {
  market: Market;
  order: OrderView;
  token: string;
}

export interface MarketProps {
  market: Market;
}

/** Layout parts, interactive widgets and whole page templates. Every one is optional in a child theme. */
export interface ThemeComponents {
  Announcement: ComponentType<MarketProps>;
  Header: ComponentType<ChromeProps>;
  Footer: ComponentType<ChromeProps>;
  /** Slide-in bag; a client component (reads the cart through `useCart`). */
  CartDrawer: ComponentType<MarketProps>;
  ProductCard: ComponentType<ProductCardProps>;
  HomeFallback: ComponentType<MarketProps>;
  ProductListPage: ComponentType<ProductListPageProps>;
  ProductDetailPage: ComponentType<ProductDetailPageProps>;
  CartPage: ComponentType<MarketProps>;
  CheckoutPage: ComponentType<MarketProps>;
  OrderPage: ComponentType<OrderPageProps>;
  NotFoundPage: ComponentType<Partial<MarketProps>>;
}

export interface BlockContext {
  market: Market;
  data: StorefrontData;
  /** The resolved active theme, so a block can render the theme's own ProductCard, buttons and so on. */
  theme: Theme;
}

/** A block renderer. Props are the block's validated props plus `ctx`; container blocks also get `children`. */
export type BlockComponent<P = Record<string, unknown>> = (
  props: P & { ctx: BlockContext; children?: ReactNode },
) => ReactNode | Promise<ReactNode>;
// Erased so heterogeneous renderers fit one map (props are validated against each block's schema before render).
export type AnyBlockComponent = BlockComponent<never>;

export interface ThemeDefinition {
  name: string;
  /** Parent theme: anything not defined here is inherited. Chains are allowed. */
  extends?: Theme;
  /** CSS custom properties applied to `:root` (e.g. `--accent`). */
  tokens?: Record<string, string>;
  /** Overrides for dark mode (`prefers-color-scheme: dark`). */
  darkTokens?: Record<string, string>;
  components?: Partial<ThemeComponents>;
  /** Replace how a block renders, by block type (`hero`, `product-grid`, `loyalty-points/banner`, ...). */
  blocks?: Record<string, AnyBlockComponent>;
  /** Extra block types this theme adds to the page builder (schema + renderer). */
  extraBlocks?: BlockDefinition[];
}

export interface Theme {
  readonly name: string;
  readonly lineage: readonly string[];
  readonly tokens: Readonly<Record<string, string>>;
  readonly darkTokens: Readonly<Record<string, string>>;
  readonly components: ThemeComponents;
  readonly blocks: Readonly<Record<string, AnyBlockComponent>>;
  readonly extraBlocks: readonly BlockDefinition[];
}

const TOKEN_KEY = /^--[a-z][a-z0-9-]{0,48}$/;
// Conservative: colours, lengths, font stacks, shadows, numbers. No `;` `{` `}` `<` `>` `\` or url()/expression().
const TOKEN_VALUE = /^[A-Za-z0-9 #%.,()'"_\-+*/:]{1,200}$/;

export class ThemeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThemeError';
  }
}

/** Validate design tokens: they end up in CSS, so a value must never be able to break out of a declaration. */
export function validateTokens(tokens: Record<string, string>, where: string): void {
  for (const [k, v] of Object.entries(tokens)) {
    if (!TOKEN_KEY.test(k))
      throw new ThemeError(`${where}: invalid token name "${k}" (use --kebab-case)`);
    if (!TOKEN_VALUE.test(v) || /url\s*\(|expression\s*\(|@import/i.test(v))
      throw new ThemeError(`${where}: invalid value for ${k}`);
  }
}

/** Resolve a theme definition against its parent chain. Throws on bad tokens so a broken theme fails the build, not the page. */
export function defineTheme(def: ThemeDefinition): Theme {
  if (!/^[a-z][a-z0-9-]*$/.test(def.name)) throw new ThemeError(`Invalid theme name "${def.name}"`);
  validateTokens(def.tokens ?? {}, `${def.name}.tokens`);
  validateTokens(def.darkTokens ?? {}, `${def.name}.darkTokens`);
  const parent = def.extends;
  if (!parent && !def.components)
    throw new ThemeError(`Theme "${def.name}" must extend a theme or provide components`);
  const components = {
    ...(parent?.components ?? {}),
    ...(def.components ?? {}),
  } as ThemeComponents;
  const missing = (
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
    ] as const
  ).filter((k) => !components[k]);
  if (missing.length > 0)
    throw new ThemeError(`Theme "${def.name}" is missing components: ${missing.join(', ')}`);
  const extra = [...(parent?.extraBlocks ?? []), ...(def.extraBlocks ?? [])];
  const types = extra.map((b) => b.type);
  if (new Set(types).size !== types.length)
    throw new ThemeError(`Theme "${def.name}" declares a block type twice`);
  return Object.freeze({
    name: def.name,
    lineage: [...(parent?.lineage ?? []), def.name],
    tokens: Object.freeze({ ...(parent?.tokens ?? {}), ...(def.tokens ?? {}) }),
    darkTokens: Object.freeze({ ...(parent?.darkTokens ?? {}), ...(def.darkTokens ?? {}) }),
    components,
    blocks: Object.freeze({ ...(parent?.blocks ?? {}), ...(def.blocks ?? {}) }),
    extraBlocks: Object.freeze(extra),
  });
}

/** `:root` dark-mode overrides as CSS text. Safe by construction: keys and values were validated by `defineTheme`. */
export function darkTokensCss(theme: Pick<Theme, 'darkTokens'>): string {
  const body = Object.entries(theme.darkTokens)
    .map(([k, v]) => `${k}:${v};`)
    .join('');
  return body
    ? `@media (prefers-color-scheme: dark){:root:not([data-theme='light']){${body}}}`
    : '';
}
