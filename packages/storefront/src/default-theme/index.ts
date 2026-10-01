import { defineTheme } from '../contract';
import './styles';
import { CartDrawer } from './components/cart-drawer';
import { ProductCard } from './components/product-card';
import { Announcement, SiteFooter, SiteHeader } from './components/site-chrome';
import { defaultBlocks } from './blocks';
import { CartPage } from './pages/cart';
import { CheckoutPage } from './pages/checkout';
import { HomeFallback } from './pages/home-fallback';
import { NotFoundPage } from './pages/not-found';
import { OrderPage } from './pages/order';
import { ProductDetailPage } from './pages/product-detail';
import { ProductListPage } from './pages/product-list';

/**
 * The theme Base ships. It is a complete storefront on its own and the parent of every custom theme:
 *
 *   export default defineTheme({ name: 'mine', extends: defaultTheme, components: { Footer: MyFooter } });
 */
export const defaultTheme = defineTheme({
  name: 'default',
  components: {
    Announcement,
    Header: SiteHeader,
    Footer: SiteFooter,
    CartDrawer,
    ProductCard,
    HomeFallback,
    ProductListPage,
    ProductDetailPage,
    CartPage,
    CheckoutPage,
    OrderPage,
    NotFoundPage,
  },
  blocks: defaultBlocks,
});

export default defaultTheme;

// Pieces a child theme commonly reuses or wraps.
export * from './components/add-to-cart';
export * from './components/buy-box';
export * from './components/cart-drawer';
export * from './components/cart-page';
export * from './components/checkout-form';
export * from './components/market-switcher';
export * from './components/pay-now';
export * from './components/product-card';
export * from './components/site-chrome';
export * from './blocks/components';
