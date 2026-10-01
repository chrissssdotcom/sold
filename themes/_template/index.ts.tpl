import { defineTheme } from '@sold/storefront';
import { defaultTheme } from '@sold/storefront/default-theme';
import { Footer } from './components/footer';
import './theme.css';

/**
 * __TITLE__
 *
 * Everything not listed here is inherited from the default theme. To change something, add it below:
 *   - tokens / darkTokens: design tokens (colours, radii, fonts), applied as CSS custom properties
 *   - components: replace a layout part or a whole page template (see ThemeComponents in @sold/storefront)
 *   - blocks: change how a page-builder block renders, by type ('hero', 'product-grid', ...)
 *   - extraBlocks: add brand-new block types to the page builder
 * Activate it with `theme: { preset: '__NAME__' }` in sold.config.ts.
 */
export default defineTheme({
  name: '__NAME__',
  extends: defaultTheme,
  tokens: {
    '--accent': '#a94a22',
    '--accent-hover': '#8f3c19',
  },
  darkTokens: {},
  components: { Footer },
  blocks: {},
  extraBlocks: [],
});
