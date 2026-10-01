# Noir: a dark editorial theme theme

A theme for this store. It extends the default theme, so you only write what you want to change.

```
index.ts            the theme definition (tokens, components, blocks)
components/         your React components (server components by default; add 'use client' for interactivity)
theme.css           your CSS, loaded after the default styles
```

- Activate: `theme: { preset: 'noir' }` in `sold.config.ts`, then `pnpm dev` (the theme is picked up at build).
- Replace a piece: write a component with the same props as the one you replace (see `ThemeComponents` in `@sold/storefront`) and list it under `components`.
- Reuse pieces of the default theme: `import { CheckoutForm, BuyBox } from '@sold/storefront/default-theme'`.
- Read the cart in a client component: `import { useCart } from '@sold/storefront/kit'`.
- Data comes in as props; a theme never touches the database.
