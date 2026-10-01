import type { z } from '@sold/extension-sdk';
import * as S from './schemas';

export interface BaseBlockMeta {
  type: string;
  title: string;
  category: string;
  propsSchema: z.ZodType<object>;
  defaultProps: object;
  container?: boolean;
}

/**
 * The block TYPES Base ships: structure only (name, props schema, defaults). Stored pages depend on these, so they are
 * stable across themes. How each one *renders* is the theme's decision (`theme.blocks`).
 */
export const baseBlockMeta: readonly BaseBlockMeta[] = [
  {
    type: 'hero',
    title: 'Hero',
    category: 'Headers',
    propsSchema: S.heroProps,
    defaultProps: { heading: 'Something *beautiful*' },
  },
  {
    type: 'feature-strip',
    title: 'Feature strip',
    category: 'Trust',
    propsSchema: S.featureStripProps,
    defaultProps: { items: [{ icon: 'truck', title: 'Fast delivery', text: 'Tracked shipping' }] },
  },
  {
    type: 'product-grid',
    title: 'Product grid',
    category: 'Commerce',
    propsSchema: S.productGridProps,
    defaultProps: {},
  },
  {
    type: 'category-tiles',
    title: 'Category tiles',
    category: 'Commerce',
    propsSchema: S.categoryTilesProps,
    defaultProps: { tiles: [{ label: 'Shop', href: '/products', image: '/art/mug.svg' }] },
  },
  {
    type: 'editorial',
    title: 'Editorial split',
    category: 'Story',
    propsSchema: S.editorialProps,
    defaultProps: { heading: 'Our story' },
  },
  {
    type: 'testimonial',
    title: 'Testimonial',
    category: 'Trust',
    propsSchema: S.testimonialProps,
    defaultProps: { quote: 'Lovely.', author: 'A customer' },
  },
  {
    type: 'cta-banner',
    title: 'Call to action',
    category: 'Story',
    propsSchema: S.ctaBannerProps,
    defaultProps: { heading: 'Ready?' },
  },
  {
    type: 'rich-text',
    title: 'Text',
    category: 'Story',
    propsSchema: S.richTextProps,
    defaultProps: { body: 'Write something.' },
  },
  {
    type: 'spacer',
    title: 'Spacer',
    category: 'Layout',
    propsSchema: S.spacerProps,
    defaultProps: {},
  },
  {
    type: 'columns',
    title: 'Columns',
    category: 'Layout',
    propsSchema: S.columnsProps,
    defaultProps: {},
    container: true,
  },
];

export type BaseBlockType = (typeof baseBlockMeta)[number]['type'];
