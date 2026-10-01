# Theming and modular storefront

The storefront is a set of **components a theme supplies**. Base owns routing, data, caching, cart and checkout logic and
security; a theme owns everything the shopper sees. You can change one token, one component, one page, or the whole look, and
inherit the rest.

```
sold.config.ts        theme: { preset: 'noir' }           which theme is active ('default' = the one Base ships)
themes/<name>/        customer-owned theme (pnpm sold theme:new <name>)
packages/storefront   @sold/storefront: the contract, the kit, the default theme
apps/web              thin routes: fetch data, pick the active theme's component, render
```

## Make a theme in a minute

```bash
pnpm sold theme:new sunset --title "Sunset"     # themes/sunset, extends the default theme
pnpm install
# sold.config.ts:  theme: { preset: 'sunset' }
pnpm dev
```

`pnpm sold theme:list` shows what is available. `themes/noir` is a complete worked example: a dark editorial re-skin built from
four small overrides (tokens, header, product card, hero block). Everything else (product page, bag, checkout, order page, the
other blocks) is inherited and still passes the accessibility checks.

## What you can change, smallest to largest

| Level                            | How                                                                                                                 | Example                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| A design token                   | `tokens: { '--accent': '#0a7' }`                                                                                    | colours, radii, fonts, shadows, spacing               |
| Dark mode                        | `darkTokens: { '--bg': '#000' }`                                                                                    |                                                       |
| Operator tweaks, no deploy       | `theme_settings.tokens` (admin) layers over the theme's tokens                                                      | change the accent for a sale                          |
| Your CSS                         | import a `.css` file in `index.ts`; it loads after the default styles                                               |                                                       |
| A layout part                    | `components: { Header, Footer, Announcement, CartDrawer }`                                                          | custom header                                         |
| A shared component               | `components: { ProductCard }`                                                                                       | every grid, listing and related-items row picks it up |
| A whole page                     | `components: { ProductDetailPage, ProductListPage, CartPage, CheckoutPage, OrderPage, NotFoundPage, HomeFallback }` | a different product page layout                       |
| How a page-builder block renders | `blocks: { hero: MyHero }`                                                                                          | existing pages keep working: same type, same props    |
| A new block type                 | `extraBlocks: [defineBlock({ ... })]`                                                                               | appears in the page builder                           |
| Part of the default theme        | `import { CheckoutForm, BuyBox } from '@sold/storefront/default-theme'`                                             | wrap or reuse pieces                                  |

Themes chain: `defineTheme({ extends: otherTheme })` works to any depth; the closest definition wins.

## The contract

Every replaceable component is typed in `@sold/storefront` (`ThemeComponents`). Page templates receive plain props (a market,
catalog data, stock, the order) and the resolved `theme`, so a custom `ProductListPage` renders _your_ `ProductCard`. A theme
never receives a database handle; blocks get a `BlockContext` with a narrow `StorefrontData` (products, stock) and the theme.
Client-side behaviour comes from the kit: `useCart()` (bag state and actions), `formatMoney`, `Price`, markets, icons.

Server components are the default. Add `'use client'` only for interactivity (the default theme's drawer, buy box and checkout
form are client components, and you can reuse them from `@sold/storefront/default-theme`).

## Safety rails

- **Tokens become CSS**, so `defineTheme` validates every name (`--kebab-case`) and value (no `;`, braces, angle brackets, backslashes,
  `url()`, `@import`, `expression()`), and the same check runs again on operator values read from the database. A bad value
  fails the build (theme) or is ignored (database); it can never inject CSS or markup.
- A theme missing a required component, a block renderer, or declaring a block type twice fails at build, not at request time.
- Block props are validated against each block's schema before render, regardless of theme. Text fields support `*accent*`
  emphasis only, never raw HTML.
- Unknown/removed block types render nothing instead of breaking the page.
- Theme code is trusted, reviewed, in-process code, like extensions (ADR-0004). It cannot reach the database through the contract,
  but nothing sandboxes it.

## How selection works

`pnpm sync` (run by dev/build/typecheck/test) runs `scripts/sync-theme.ts`, which writes `apps/web/.generated/theme.ts` as a
static import of the active theme (bundlers cannot follow dynamic imports). An unknown preset fails with the fix
(`pnpm sold theme:new <name>`). Tooling that only validates pages (seed script, admin API) uses `createSchemaRegistry()` and never
loads a theme (themes import CSS, which only bundlers can).

## Tests

`packages/storefront` covers inheritance, chaining, block overrides, token validation (hostile values), registries; `themes/noir`
is type-checked and linted like any code; the CLI scaffold is tested including hostile titles; the real-browser e2e and axe checks
run against whichever theme is active (verified on `default` and `noir`: zero WCAG 2.2 AA violations).
