# Storefront

The storefront is modular: see [theming.md](./theming.md) for how to restyle or replace any part of it.

A server-rendered Next.js storefront over the commerce core, with a page builder for content pages.

## Try it

```bash
pnpm db:migrate                       # base + extension migrations (needs the env from .env)
pnpm --filter @sold/web seed:demo     # 9 products with illustrations, USD prices via FX, WELCOME10, 5 pages x 2 markets
pnpm --filter @sold/web dev           # http://localhost:3000  (redirects to /en-au)
SOLD_E2E_URL=http://localhost:3000 pnpm --filter @sold/web test:e2e
```

Production builds need `NODE_ENV=production` (Next misbehaves with a non-standard value) and enforce extension database
isolation (`SOLD_EXTENSION_DB_SECRET`, see ADR-0004).

## Design system

`packages/storefront/src/default-theme/styles/*.css` (nine small modules): plain CSS tokens (colour, type scale, radii, shadows), warm paper/ink with one
terracotta accent, automatic dark mode, `prefers-reduced-motion` respected, self-hosted variable fonts (Fraunces + Inter),
visible focus rings, skip link. Every value is a token an operator can override at runtime from `theme_settings`.
Product and editorial art is procedurally generated SVG (`scripts/gen-art.mjs`), so the demo has no licensed or binary assets.

## Routing and caching

- `/<market>/...` where a market is a locale slug (`en-au`, `en-us`) that also fixes the presentment currency (`storefront/lib/i18n.ts`).
  `proxy.ts` redirects unprefixed paths using `Accept-Language`. Each page emits `hreflang` alternates; `sitemap.xml` and `robots.txt` are generated
  (non-production is never indexed).
- Catalogue and content pages render on first request and are then served from the shared ISR cache (`revalidate = 60`,
  `generateStaticParams = []`, so **nothing needs a database at build time**). Verified on a production build: `x-nextjs-cache: MISS` then `HIT`,
  `Cache-Control: s-maxage=60, stale-while-revalidate`.
- Storefront reads use the **replica** and never boot the extension kernel; bag, checkout and order pages are dynamic and `private, no-store`.
- Cart identity is an HMAC-signed HttpOnly cookie (`__Host-` over https); order pages are addressed by a signed order token. A bare id is never a credential.

## Page builder

Pages are trees of blocks stored as immutable versions (`@sold/content`). Saving appends a version validated against the block registry
(unknown blocks, bad props, depth/size/count limits, prototype-pollution keys are all refused, with every issue listed). Publishing moves one
pointer and emits `page.published`; rolling back is publishing an older version. Base blocks: hero, feature strip, product grid, category tiles,
editorial split, testimonial, call-to-action, rich text, spacer, columns. Extension blocks (`<extension>/<type>`) register into the same registry.
Text fields support only `*accent*` emphasis, never raw HTML.

## Verified

- Real-browser flow (Playwright + Chromium) on a production build with extension DB isolation enforced: add to bag, coupon, checkout, order page,
  empty bag afterwards, per-market currency, sold-out product not purchasable, forged cart cookie refused.
- axe-core WCAG 2.0/2.1/2.2 A and AA: **0 violations** on home, shop, product, bag, checkout and about, in light and dark.

## Not built yet (be honest)

- No admin UI for editing pages, products or orders (the services and APIs exist; identity and the admin app are Phase 5).
- No search, collections/filters, reviews, wishlist, or account area (accounts arrive with identity).
- Card entry: the Stripe adapter exists, but the storefront has no Stripe Elements integration, so only offline ("manual") payment completes in the UI today.
- No image pipeline (art is SVG); responsive raster images and Cloudflare Images are Phase 7.
- CSP: not yet set. A nonce-based policy would force dynamic rendering and defeat the CDN cache; the plan is a hash/`strict-dynamic`-free policy
  with no inline scripts except Next's, decided when the admin app lands (tracked in docs/PROGRESS.md open questions).
- Lighthouse / Core Web Vitals budgets have not been measured.
