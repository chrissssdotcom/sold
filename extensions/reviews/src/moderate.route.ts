import { sql, type RouteContext, type RouteDefinition } from '@sold/extension-sdk';
import { moderationInput, uuidParam } from './input';
import type { Settings } from './settings';

type Ctx = RouteContext<Settings> & { params: Record<string, string> };
const json = (status: number, body: unknown) => Response.json(body, { status });

export const moderationQueue: RouteDefinition<RouteContext<Settings>> = {
  kind: 'admin',
  method: 'GET',
  path: '/queue',
  permission: 'reviews.moderate',
  async handler(_request, ctx) {
    const rows = await ctx.db.primary.execute(sql`
      SELECT r.id, r.product_id, r.rating, r.title, r.body, r.author_name, r.created_at,
             (SELECT title FROM products p WHERE p.id = r.product_id::uuid) AS product_title
      FROM ext_reviews_reviews r WHERE r.status = 'pending' ORDER BY r.created_at LIMIT 100`);
    return json(200, {
      items: (rows.rows as Record<string, string | number>[]).map((r) => ({
        id: r['id'],
        productId: r['product_id'],
        productTitle: r['product_title'] ?? null,
        rating: r['rating'],
        title: r['title'],
        body: r['body'],
        authorName: r['author_name'],
        createdAt: new Date(String(r['created_at'])).toISOString(),
      })),
    });
  },
};

export const moderateReview: RouteDefinition<RouteContext<Settings>> = {
  kind: 'admin',
  method: 'POST',
  path: '/reviews/:id/moderate',
  permission: 'reviews.moderate',
  async handler(request, rawCtx) {
    const ctx = rawCtx as Ctx;
    const id = uuidParam.safeParse(ctx.params['id']);
    if (!id.success) return json(404, { error: { code: 'not_found', message: 'Unknown review' } });
    const input = moderationInput.safeParse(await request.json().catch(() => null));
    if (!input.success)
      return json(422, {
        error: { code: 'validation_failed', message: 'status must be approved or rejected' },
      });
    const res = await ctx.db.primary.execute(sql`
      UPDATE ext_reviews_reviews SET status = ${input.data.status}, moderated_at = now(), moderated_by = ${ctx.actor?.id ?? 'unknown'}
      WHERE id = ${id.data} RETURNING id`);
    if (res.rows.length === 0)
      return json(404, { error: { code: 'not_found', message: 'Unknown review' } });
    ctx.log.info(
      { reviewId: id.data, status: input.data.status, by: ctx.actor?.id },
      'review moderated',
    );
    return json(200, { ok: true });
  },
};
