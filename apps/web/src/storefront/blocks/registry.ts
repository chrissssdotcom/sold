import { BlockRegistry } from '@sold/content';
import { defineBlock } from '@sold/extension-sdk';
import * as S from './schemas';

const thumb = (label: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" rx="10" fill="#f2ebe0"/><text x="80" y="55" text-anchor="middle" font-family="sans-serif" font-size="13" fill="#6a6056">${label}</text></svg>`)}`;

/** Lazy component loaders keep block code out of bundles that do not render that block. */
const load =
  <K extends string>(name: K) =>
  () =>
    import('./components').then((m) => ({ default: (m as never as Record<K, never>)[name] }));

let cached: BlockRegistry | undefined;

/** The blocks Base ships. Extension blocks (`<extension>/<type>`) are registered on top at boot. */
export function baseRegistry(): BlockRegistry {
  if (cached) return cached;
  const r = new BlockRegistry();
  const def = <T extends Parameters<typeof defineBlock>[0]>(d: T, container = false) =>
    r.register(defineBlock(d), { container });
  def({
    type: 'hero',
    title: 'Hero',
    category: 'Headers',
    propsSchema: S.heroProps,
    defaultProps: { heading: 'Something *beautiful*' },
    component: load('Hero'),
    thumbnail: thumb('Hero'),
  });
  def({
    type: 'feature-strip',
    title: 'Feature strip',
    category: 'Trust',
    propsSchema: S.featureStripProps,
    defaultProps: { items: [{ icon: 'truck', title: 'Fast delivery', text: 'Tracked shipping' }] },
    component: load('FeatureStrip'),
    thumbnail: thumb('Features'),
  });
  def({
    type: 'product-grid',
    title: 'Product grid',
    category: 'Commerce',
    propsSchema: S.productGridProps,
    defaultProps: {},
    component: load('ProductGrid'),
    thumbnail: thumb('Products'),
  });
  def({
    type: 'category-tiles',
    title: 'Category tiles',
    category: 'Commerce',
    propsSchema: S.categoryTilesProps,
    defaultProps: { tiles: [{ label: 'Shop', href: '/products', image: '/art/mug.svg' }] },
    component: load('CategoryTiles'),
    thumbnail: thumb('Tiles'),
  });
  def({
    type: 'editorial',
    title: 'Editorial split',
    category: 'Story',
    propsSchema: S.editorialProps,
    defaultProps: { heading: 'Our story' },
    component: load('Editorial'),
    thumbnail: thumb('Editorial'),
  });
  def({
    type: 'testimonial',
    title: 'Testimonial',
    category: 'Trust',
    propsSchema: S.testimonialProps,
    defaultProps: { quote: 'Lovely.', author: 'A customer' },
    component: load('Testimonial'),
    thumbnail: thumb('Quote'),
  });
  def({
    type: 'cta-banner',
    title: 'Call to action',
    category: 'Story',
    propsSchema: S.ctaBannerProps,
    defaultProps: { heading: 'Ready?' },
    component: load('CtaBanner'),
    thumbnail: thumb('CTA'),
  });
  def({
    type: 'rich-text',
    title: 'Text',
    category: 'Story',
    propsSchema: S.richTextProps,
    defaultProps: { body: 'Write something.' },
    component: load('RichText'),
    thumbnail: thumb('Text'),
  });
  def({
    type: 'spacer',
    title: 'Spacer',
    category: 'Layout',
    propsSchema: S.spacerProps,
    defaultProps: {},
    component: load('Spacer'),
    thumbnail: thumb('Spacer'),
  });
  def(
    {
      type: 'columns',
      title: 'Columns',
      category: 'Layout',
      propsSchema: S.columnsProps,
      defaultProps: {},
      component: load('Columns'),
      thumbnail: thumb('Columns'),
    },
    true,
  );
  cached = r;
  return r;
}
