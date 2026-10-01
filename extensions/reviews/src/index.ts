import { defineBlock, defineExtension, z } from '@sold/extension-sdk';
import { moderateReview, moderationQueue } from './moderate.route';
import { listReviews, submitReview } from './reviews.route';
import { settings } from './settings';

const thumbnail = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" rx="10" fill="#f2ebe0"/><text x="80" y="58" text-anchor="middle" font-family="sans-serif" font-size="22" fill="#a94a22">★★★★★</text></svg>')}`;

/**
 * Verified-buyer product reviews with moderation.
 *  - Only customers with a paid order containing the product can post (checked against Base's order tables, read-only).
 *  - One review per customer per product; editing sends it back through moderation unless `autoApprove` is on.
 *  - The storefront widget loads client-side from a public, cacheable list route.
 */
export default defineExtension({
  name: 'reviews',
  version: '0.1.0',
  description: 'Verified-buyer product reviews with moderation.',
  requires: { base: '^0.1.0' },
  performance: { hotPath: false },
  migrations: { dir: 'migrations' },
  settings: { schema: settings },
  permissions: [{ key: 'reviews.moderate', description: 'Approve or reject customer reviews' }],
  routes: [listReviews, submitReview, moderationQueue, moderateReview],

  // Product page: appears under the buy box.
  slots: [
    {
      slot: 'product.detail.aside',
      id: 'product-reviews',
      order: 50,
      component: () => import('./product-reviews.client'),
    },
  ],

  // Page builder: "reviews/product-reviews".
  blocks: [
    defineBlock({
      type: 'product-reviews',
      title: 'Product reviews',
      category: 'Social proof',
      description: 'Reviews and rating summary for one product.',
      propsSchema: z.object({ productId: z.uuid().meta({ title: 'Product id' }) }),
      defaultProps: { productId: '00000000-0000-7000-8000-000000000000' },
      component: () => import('./product-reviews.block'),
      thumbnail,
    }),
  ],

  // Admin console: Marketing > Review moderation.
  adminScreens: [
    {
      path: '/moderation',
      title: 'Review moderation',
      permission: 'reviews.moderate',
      nav: { section: 'Marketing', order: 10 },
      component: () => import('./moderation.client'),
    },
  ],

  reportingViews: [
    {
      name: 'review_summary',
      description: 'Approved review count and average rating per product.',
      sql: "SELECT product_id, count(*) AS reviews, round(avg(rating), 2) AS average FROM ext_reviews_reviews WHERE status = 'approved' GROUP BY product_id",
    },
  ],
});
