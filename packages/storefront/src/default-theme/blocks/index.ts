import type { AnyBlockComponent } from '../../contract';
import * as C from './components';

/** Renderers for every Base block type. A child theme overrides any of these by type. */
export const defaultBlocks: Record<string, AnyBlockComponent> = {
  hero: C.Hero as never,
  'feature-strip': C.FeatureStrip as never,
  'product-grid': C.ProductGrid as never,
  'category-tiles': C.CategoryTiles as never,
  editorial: C.Editorial as never,
  testimonial: C.Testimonial as never,
  'cta-banner': C.CtaBanner as never,
  'rich-text': C.RichText as never,
  spacer: C.Spacer as never,
  columns: C.Columns as never,
};
export * from './components';
