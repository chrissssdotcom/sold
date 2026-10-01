import { sql, type RouteContext, type RouteDefinition } from '@sold/extension-sdk';
import { cleanText, reviewInput, roundAverage, uuidParam, type Summary } from './input';
import type { Settings } from './settings';

type Ctx = RouteContext<Settings> & { params: Record<string, string> };

const json = (status: number, body: unknown) => Response.json(body, { status });
const bad = (status: number, code: string, message: string) =>
  json(status, { error: { code, message } });

/** Orders that count as a purchase: money has landed (not pending or cancelled). Base's order tables are readable by extensions. */
const PURCHASED = sql`o.status IN ('paid', 'processing', 'shipped', 'delivered')`;

export const listReviews: RouteDefinition<RouteContext<Settings>> = {
  kind: 'api',
  method: 'GET',
  path: '/products/:productId/reviews',
  public: true,
  cache: { maxAgeSeconds: 60, scope: 'public' },
  async handler(request, rawCtx) {
    const ctx = rawCtx as Ctx;
    const productId = uuidParam.safeParse(ctx.params['productId']);
    if (!productId.success) return bad(404, 'not_found', 'Unknown product');
    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 10) || 10, 1), 50);
    const before = uuidParam.safeParse(url.searchParams.get('before') ?? undefined);

    const [summaryRows, reviewRows] = await Promise.all([
      ctx.db.replica.execute(sql`
        SELECT count(*)::int AS count, COALESCE(sum(rating), 0)::int AS total,
               count(*) FILTER (WHERE rating = 1)::int AS r1, count(*) FILTER (WHERE rating = 2)::int AS r2,
               count(*) FILTER (WHERE rating = 3)::int AS r3, count(*) FILTER (WHERE rating = 4)::int AS r4,
               count(*) FILTER (WHERE rating = 5)::int AS r5
        FROM ext_reviews_reviews WHERE product_id = ${productId.data} AND status = 'approved'`),
      ctx.db.replica.execute(sql`
        SELECT id, rating, title, body, author_name, created_at
        FROM ext_reviews_reviews
        WHERE product_id = ${productId.data} AND status = 'approved'
          AND (${before.success ? before.data : null}::uuid IS NULL
               OR (created_at, id) < (SELECT created_at, id FROM ext_reviews_reviews WHERE id = ${before.success ? before.data : null}::uuid))
        ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`),
    ]);
    const s = summaryRows.rows[0] as Record<string, number>;
    const summary: Summary = {
      count: s['count'] ?? 0,
      average: roundAverage(s['total'] ?? 0, s['count'] ?? 0),
      distribution: {
        '1': s['r1'] ?? 0,
        '2': s['r2'] ?? 0,
        '3': s['r3'] ?? 0,
        '4': s['r4'] ?? 0,
        '5': s['r5'] ?? 0,
      },
    };
    const rows = reviewRows.rows as {
      id: string;
      rating: number;
      title: string;
      body: string;
      author_name: string;
      created_at: string;
    }[];
    const page = rows.slice(0, limit);
    return json(200, {
      summary,
      reviews: page.map((r) => ({
        id: r.id,
        rating: r.rating,
        title: r.title,
        body: r.body,
        authorName: r.author_name,
        createdAt: new Date(r.created_at).toISOString(),
        verifiedBuyer: true, // only verified purchases can be stored
      })),
      nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    });
  },
};

export const submitReview: RouteDefinition<RouteContext<Settings>> = {
  kind: 'api',
  method: 'POST',
  path: '/products/:productId/reviews',
  customer: true,
  async handler(request, rawCtx) {
    const ctx = rawCtx as Ctx;
    const customerId = ctx.actor?.id;
    if (!customerId) return bad(401, 'unauthenticated', 'Sign in to write a review');
    const productId = uuidParam.safeParse(ctx.params['productId']);
    if (!productId.success) return bad(404, 'not_found', 'Unknown product');

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return bad(400, 'invalid_json', 'Body must be JSON');
    }
    const parsed = reviewInput.safeParse(raw);
    if (!parsed.success)
      return json(422, {
        error: {
          code: 'validation_failed',
          message: 'Invalid review',
          details: {
            issues: parsed.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
        },
      });

    // Only people who bought the product may review it. (A customer id is a uuid in Base's orders table.)
    const bought = await ctx.db.primary.execute(sql`
      SELECT 1 FROM orders o
      JOIN order_lines ol ON ol.order_id = o.id
      JOIN product_variants v ON v.id = ol.variant_id
      WHERE o.customer_id = ${customerId}::uuid AND v.product_id = ${productId.data}::uuid AND ${PURCHASED}
      LIMIT 1`);
    if (bought.rows.length === 0)
      return bad(403, 'not_a_buyer', 'Only customers who bought this product can review it');

    const cfg = await ctx.settings.get();
    const status = cfg.autoApprove ? 'approved' : 'pending';
    const name = cleanText(parsed.data.authorName) || 'Verified buyer';
    const row = await ctx.db.primary.execute(sql`
      INSERT INTO ext_reviews_reviews (product_id, customer_id, rating, title, body, author_name, status)
      VALUES (${productId.data}, ${customerId}, ${parsed.data.rating}, ${parsed.data.title}, ${parsed.data.body}, ${name}, ${status})
      ON CONFLICT (product_id, customer_id) DO UPDATE
        SET rating = EXCLUDED.rating, title = EXCLUDED.title, body = EXCLUDED.body, author_name = EXCLUDED.author_name,
            status = EXCLUDED.status, updated_at = now(), moderated_at = NULL, moderated_by = NULL
      RETURNING id, status`);
    const saved = row.rows[0] as { id: string; status: string };
    return json(201, { id: saved.id, status: saved.status });
  },
};
