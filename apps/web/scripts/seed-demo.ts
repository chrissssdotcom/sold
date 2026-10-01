/**
 * Seeds a demo store: products with illustrations, stock, AUD prices plus derived USD prices, a welcome coupon and the
 * storefront pages. Idempotent (existing handles/pages are left alone). Local and demo environments only.
 *   pnpm --filter @sold/web seed:demo
 */
import { PageService, type BlockRegistry } from '@sold/content';
import { CatalogService, PromotionService } from '@sold/commerce';
import { loadEnv } from '@sold/core/env';
import { createDb, eq, schema } from '@sold/db';
import { FxService, StaticFxProvider } from '@sold/payments';
import { createSchemaRegistry } from '@sold/storefront/blocks';

const env = loadEnv();
if (env.SOLD_ENVIRONMENT === 'prod') throw new Error('Refusing to seed demo data in prod');
const db = createDb({ primaryUrl: env.DATABASE_URL, applicationName: 'sold-seed' });
const catalog = new CatalogService();

interface Item {
  handle: string;
  title: string;
  subtitle: string;
  price: bigint;
  compareAt?: bigint;
  art: string;
  stock: number;
  badge?: string;
  collection: string;
  description: string;
  highlights: string[];
  variants?: string[];
  weight: number;
}

const items: Item[] = [
  {
    handle: 'ember-candle',
    title: 'Ember Candle',
    subtitle: 'Soy wax, cedar and smoked amber',
    price: 4800n,
    art: 'candle',
    stock: 40,
    badge: 'Bestseller',
    collection: 'Home',
    weight: 450,
    description:
      'Poured by hand in small batches into a reusable amber glass jar. A slow, even burn of roughly 50 hours and a scent that feels like the last light of the day.',
    highlights: ['50-hour burn time', '100% soy wax, cotton wick', 'Reusable glass jar'],
  },
  {
    handle: 'hearth-mug',
    title: 'Hearth Mug',
    subtitle: 'Hand-glazed stoneware, 350 ml',
    price: 3800n,
    art: 'mug',
    stock: 60,
    collection: 'Kitchen',
    variants: ['Terracotta', 'Oat'],
    weight: 380,
    description:
      'Thrown, dipped and fired twice. The glaze pools a little differently on every mug, so no two are quite alike. Dishwasher and microwave safe.',
    highlights: [
      'Dishwasher and microwave safe',
      'Each one slightly unique',
      'Holds a generous 350 ml',
    ],
  },
  {
    handle: 'linen-tote',
    title: 'Everyday Tote',
    subtitle: 'Heavy organic cotton canvas',
    price: 4500n,
    art: 'tote',
    stock: 75,
    collection: 'Carry',
    weight: 320,
    description:
      'Roomy, reinforced and softer with every wash. Holds a week of groceries or a laptop and a change of clothes.',
    highlights: ['Organic cotton canvas', 'Reinforced stitched handles', 'Machine washable'],
  },
  {
    handle: 'halo-lamp',
    title: 'Halo Table Lamp',
    subtitle: 'Warm linen shade, matte steel base',
    price: 18900n,
    art: 'lamp',
    stock: 3,
    badge: 'New',
    collection: 'Lighting',
    weight: 1800,
    description:
      'A soft pool of light for reading corners and bedside tables. Dimmable with any standard dimmer and supplied with a warm-white bulb.',
    highlights: [
      'Dimmable, warm-white bulb included',
      'Steel base with linen shade',
      '1.8 m braided cord',
    ],
  },
  {
    handle: 'still-vase',
    title: 'Still Bud Vase',
    subtitle: 'Glazed ceramic, sage green',
    price: 6800n,
    art: 'vase',
    stock: 0,
    collection: 'Home',
    weight: 900,
    description:
      'Made for a few stems rather than a bouquet. The narrow neck keeps them standing just so.',
    highlights: ['Watertight glaze', 'Hand finished', 'Made for small stems'],
  },
  {
    handle: 'field-notebook',
    title: 'Field Notebook',
    subtitle: 'Lay-flat, dot grid, 192 pages',
    price: 2800n,
    art: 'notebook',
    stock: 120,
    collection: 'Desk',
    weight: 260,
    description:
      'Thread-bound so it opens flat, with thick acid-free paper that takes fountain pen without bleeding and an elastic closure.',
    highlights: [
      'Lay-flat thread binding',
      '120 gsm acid-free paper',
      'Elastic closure and ribbon',
    ],
  },
  {
    handle: 'fern-pot',
    title: 'Terracotta Planter',
    subtitle: 'Unglazed clay with drainage',
    price: 5900n,
    art: 'plant',
    stock: 30,
    collection: 'Home',
    weight: 1400,
    description:
      'Breathable clay that helps roots stay healthy, finished with a rolled rim and a matching saucer.',
    highlights: ['Drainage hole and saucer', 'Frost-tolerant clay', 'Fits a 20 cm nursery pot'],
  },
  {
    handle: 'trail-bottle',
    title: 'Trail Bottle',
    subtitle: 'Insulated steel, 750 ml',
    price: 4200n,
    art: 'bottle',
    stock: 55,
    collection: 'Carry',
    weight: 410,
    description:
      'Cold for 24 hours and hot for 12. Leak-proof, dent-resistant and built to be carried everywhere.',
    highlights: ['24 h cold, 12 h hot', 'Leak-proof lid', 'Powder-coated, dent resistant'],
  },
  {
    handle: 'harvest-bowl',
    title: 'Harvest Serving Bowl',
    subtitle: 'Wide stoneware, painted band',
    price: 7400n,
    compareAt: 8900n,
    art: 'bowl',
    stock: 18,
    collection: 'Kitchen',
    weight: 1100,
    description:
      'Big enough for the whole table. A hand-painted terracotta band runs around the belly of every bowl.',
    highlights: ['28 cm across', 'Oven and dishwasher safe', 'Hand-painted band'],
  },
];

const t = (id: string, type: string, props: Record<string, unknown>, children?: unknown[]) => ({
  id,
  type,
  props,
  ...(children ? { children } : {}),
});

const home = [
  t('hero', 'hero', {
    eyebrow: 'Spring collection',
    heading: 'Objects for the *slow* mornings',
    body: 'Hand-finished ceramics, candles and everyday carry, made in small batches by people who care how things feel in your hands.',
    primary: { label: 'Shop the collection', href: '/products' },
    secondary: { label: 'Our story', href: '/about' },
    proof: 'Loved by 12,000+ happy homes',
  }),
  t('features', 'feature-strip', {
    items: [
      { icon: 'truck', title: 'Free delivery', text: 'On every order over A$150' },
      { icon: 'refresh', title: '30-day returns', text: 'Changed your mind? No problem' },
      { icon: 'leaf', title: 'Made to last', text: 'Small batches, natural materials' },
      { icon: 'shield', title: 'Secure checkout', text: 'Your details stay private' },
    ],
  }),
  t('featured', 'product-grid', {
    eyebrow: 'Customer favourites',
    heading: 'Things people keep coming back for',
    handles: ['ember-candle', 'hearth-mug', 'linen-tote', 'halo-lamp'],
    viewAll: { label: 'Shop all', href: '/products' },
  }),
  t('tiles', 'category-tiles', {
    eyebrow: 'Browse by room',
    heading: 'Find your corner',
    tiles: [
      { label: 'Kitchen & table', href: '/products', image: '/art/bowl.svg' },
      { label: 'Living', href: '/products', image: '/art/vase.svg' },
      { label: 'Carry & desk', href: '/products', image: '/art/notebook.svg' },
    ],
  }),
  t('story', 'editorial', {
    eyebrow: 'The makers',
    heading: 'Made slowly, on purpose',
    tint: true,
    body: 'Every piece starts with a small studio and a simple question: will this still be loved in ten years? We work with makers who use natural materials and finish by hand, so what arrives at your door has a little of them in it.',
    cta: { label: 'Read our story', href: '/about' },
  }),
  t('new', 'product-grid', { eyebrow: 'Just landed', heading: 'New this season', limit: 4 }),
  t('quote', 'testimonial', {
    quote:
      'The candle filled the whole house and the packaging was so thoughtful I kept the box. Already ordered two more as gifts.',
    author: 'Priya S.',
    role: 'Verified buyer',
  }),
  t('cta', 'cta-banner', {
    heading: 'Take 10% off your first order',
    body: 'Use the code WELCOME10 at checkout. Free delivery over A$150.',
    cta: { label: 'Start shopping', href: '/products' },
  }),
];

const text = (id: string, heading: string, body: string) => [t(id, 'rich-text', { heading, body })];
const pages: { path: string; title: string; tree: unknown[]; seo?: Record<string, unknown> }[] = [
  {
    path: '/',
    title: 'Home',
    tree: home,
    seo: {
      title: 'Considered objects for everyday rituals',
      description: 'Hand-finished ceramics, candles and everyday carry, made in small batches.',
    },
  },
  {
    path: '/about',
    title: 'Our story',
    seo: { description: 'Who we are and how we make things.' },
    tree: [
      t('story', 'editorial', {
        eyebrow: 'About us',
        heading: 'A small studio with *big* patience',
        body: 'We started in a garage with one kiln and a stubborn belief that everyday things deserve care. Today we work with a handful of makers across Australia and New Zealand.',
        cta: { label: 'Shop what we make', href: '/products' },
      }),
      ...text(
        'body',
        '',
        '## How we choose\n\nWe only sell things we use ourselves. If it is not beautiful, durable and repairable or recyclable, it does not make the cut.\n\n## Our promise\n\nIf something arrives damaged or simply is not right, tell us within 30 days and we will make it right.',
      ),
    ],
  },
  {
    path: '/journal',
    title: 'Journal',
    tree: text(
      'body',
      'The journal',
      'Stories from the studio, care guides and ideas for slower days. New entries are on their way.',
    ),
  },
  {
    path: '/shipping',
    title: 'Shipping & returns',
    tree: text(
      'body',
      'Shipping & returns',
      '## Delivery\n\nOrders ship within 1–2 business days. Delivery is free over A$150; otherwise it is a flat rate that depends on where you are.\n\n## Returns\n\nNot in love? Return unused items in their original packaging within 30 days for a full refund.',
    ),
  },
  {
    path: '/privacy',
    title: 'Privacy',
    tree: text(
      'body',
      'Privacy',
      'We collect only what we need to fulfil your order and never sell your data. Payment details are handled by our payment provider and never touch our servers.',
    ),
  },
];

async function main() {
  // Catalogue
  for (const it of items) {
    const exists = await db.primary
      .select({ id: schema.products.id })
      .from(schema.products)
      .where(eq(schema.products.handle, it.handle));
    if (exists.length > 0) continue;
    const variantNames = it.variants ?? [''];
    await catalog.create(db.primary, {
      handle: it.handle,
      title: it.title,
      description: it.description,
      status: 'active',
      tags: [it.collection.toLowerCase()],
      attributes: {
        subtitle: it.subtitle,
        badge: it.badge,
        images: [`/art/${it.art}.svg`],
        highlights: it.highlights,
        collection: it.collection,
      },
      variants: variantNames.map((name, i) => ({
        sku: `${it.handle.toUpperCase()}${variantNames.length > 1 ? `-${i + 1}` : ''}`,
        title: name,
        weightGrams: it.weight,
        prices: [
          {
            currency: 'AUD',
            amount: it.price.toString(),
            ...(it.compareAt ? { compareAt: it.compareAt.toString() } : {}),
          },
        ],
        onHand: it.stock,
      })),
    });
  }
  // FX and derived prices for the USD market
  const fx = new FxService();
  await fx.refresh(db.primary, new StaticFxProvider({ AUDUSD: '0.65' }), 'AUD', ['USD']);
  const derived = await fx.deriveAll(db.primary, {
    base: 'AUD',
    targets: [{ code: 'USD', rounding: '.99' }],
  });
  // Coupon
  const promo = new PromotionService();
  const hasCoupon = await db.primary
    .select({ id: schema.promotions.id })
    .from(schema.promotions)
    .where(eq(schema.promotions.code, 'welcome10'));
  if (hasCoupon.length === 0)
    await promo.create(db.primary, {
      name: 'Welcome 10%',
      code: 'WELCOME10',
      kind: 'percent_off',
      basisPoints: 1000,
      stackable: true,
    });
  // Pages
  const registry: BlockRegistry = createSchemaRegistry();
  const svc = new PageService(registry);
  for (const locale of ['en-au', 'en-us']) {
    for (const p of pages) {
      const existing = await svc.getPublished(db.primary, locale, p.path);
      if (existing) continue;
      const page = await svc
        .create(db.primary, {
          path: p.path,
          locale,
          title: p.title,
          seo: p.seo ?? {},
          actor: 'seed',
        })
        .catch(async (e: { code?: string }) => {
          if (e.code !== 'page_exists') throw e;
          const r = await db.primary
            .select()
            .from(schema.pages)
            .where(eq(schema.pages.path, p.path));
          return r.find((x) => x.locale === locale)!;
        });
      const saved = await svc.saveDraft(db.primary, page.id, p.tree, {
        actor: 'seed',
        note: 'demo content',
      });
      await svc.publish(db.primary, page.id, saved.version, 'seed');
    }
  }
  console.log(
    `seeded: ${items.length} products, derived USD prices written: ${derived.written}, ${pages.length} pages x 2 locales`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.close());
