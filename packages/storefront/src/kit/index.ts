/** Building blocks any theme can reuse: formatting, markets, product helpers, the cart hook, icons. */
export * from './i18n';
export * from './money';
export * from './product';
export * from './price';
export * from './icons';
export { CartProvider, useCart, type CartItem } from './cart-provider';
export * from './consent-cookie';
export * from './events';
export { ConsentBanner, ConsentSettingsLink, CONSENT_EVENT } from './consent';
export { TrackViewItem } from './track';
