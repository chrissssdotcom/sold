import { defineTheme } from '@sold/storefront';
import { defaultTheme } from '@sold/storefront/default-theme';
import { Header } from './components/header';
import { Footer } from './components/footer';
import { ProductCard } from './components/product-card';
import { Hero } from './components/hero';
import './theme.css';

/**
 * Noir: a dark, editorial take on the store. It extends the default theme and changes four things: design tokens, the
 * header, the product card and the hero block. Everything else (pages, cart, checkout, the other blocks) is inherited.
 * Compare with the default theme to see how little a full re-skin needs.
 */
export default defineTheme({
  name: 'noir',
  extends: defaultTheme,
  tokens: {
    '--bg': '#0e0d0c',
    '--surface': '#181614',
    '--surface-2': '#211e1b',
    '--surface-3': '#2c2823',
    '--ink': '#f3ece1',
    '--ink-2': '#cfc5b5',
    '--muted': '#a89d8c',
    '--line': '#2f2a25',
    '--line-strong': '#4a433b',
    '--accent': '#d9b565',
    '--accent-hover': '#e6c984',
    '--accent-ink': '#17120a',
    '--accent-soft': '#2b2417',
    '--focus': '#8db4ff',
    '--r-sm': '3px',
    '--r-md': '4px',
    '--r-lg': '6px',
    '--r-pill': '3px',
  },
  components: { Header, Footer, ProductCard },
  blocks: { hero: Hero },
});
