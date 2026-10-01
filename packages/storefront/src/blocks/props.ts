import type { z } from '@sold/extension-sdk';
import type { BlockContext } from '../contract';
import type * as S from './schemas';

type P<T extends z.ZodType> = z.output<T> & { ctx: BlockContext };

/** Props each Base block type receives (validated props plus the render context). Use these to replace a block's renderer. */
export interface BaseBlockProps {
  hero: P<typeof S.heroProps>;
  'feature-strip': P<typeof S.featureStripProps>;
  'product-grid': P<typeof S.productGridProps>;
  'category-tiles': P<typeof S.categoryTilesProps>;
  editorial: P<typeof S.editorialProps>;
  testimonial: P<typeof S.testimonialProps>;
  'cta-banner': P<typeof S.ctaBannerProps>;
  'rich-text': P<typeof S.richTextProps>;
  spacer: P<typeof S.spacerProps>;
}
