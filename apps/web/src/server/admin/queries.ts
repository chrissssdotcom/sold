import { and, desc, eq, ilike, lt, or, schema, sql, type PrimaryDb } from '@sold/db';

const { products, productVariants, inventoryLevels, orders, pages, promotions, users, auditLog } =
  schema;

/** Admin read models. Staff traffic is low and must see its own writes, so these read the primary. Every list is bounded and keyset-paginated. */
const clamp = (n: number | undefined, max = 100, dflt = 25) =>
  Math.max(1, Math.min(max, Math.trunc(n ?? dflt)));

export async function listProducts(
  db: PrimaryDb,
  opts: { q?: string; status?: string; limit?: number; before?: string },
) {
  const where = and(
    opts.status ? eq(products.status, opts.status) : undefined,
    opts.q
      ? or(
          ilike(products.title, `%${escapeLike(opts.q)}%`),
          ilike(products.handle, `%${escapeLike(opts.q)}%`),
        )
      : undefined,
    opts.before ? lt(products.id, opts.before) : undefined,
  );
  const limit = clamp(opts.limit);
  const rows = await db
    .select({
      id: products.id,
      handle: products.handle,
      title: products.title,
      status: products.status,
      variants: sql<number>`(SELECT count(*)::int FROM product_variants v WHERE v.product_id = ${products.id})`,
      onHand: sql<number>`COALESCE((SELECT sum(l.on_hand)::int FROM inventory_levels l JOIN product_variants v ON v.id = l.variant_id WHERE v.product_id = ${products.id}), 0)`,
    })
    .from(products)
    .where(where)
    .orderBy(desc(products.id))
    .limit(limit + 1);
  return page(rows, limit);
}

export async function listOrders(
  db: PrimaryDb,
  opts: { status?: string; q?: string; limit?: number; before?: string },
) {
  const where = and(
    opts.status ? eq(orders.status, opts.status) : undefined,
    opts.q
      ? or(
          ilike(orders.email, `%${escapeLike(opts.q)}%`),
          /^\d{1,18}$/.test(opts.q) ? eq(orders.number, BigInt(opts.q)) : undefined,
        )
      : undefined,
    opts.before ? lt(orders.id, opts.before) : undefined,
  );
  const limit = clamp(opts.limit);
  const rows = await db
    .select({
      id: orders.id,
      number: orders.number,
      email: orders.email,
      status: orders.status,
      currency: orders.currency,
      total: orders.total,
      placedAt: orders.placedAt,
    })
    .from(orders)
    .where(where)
    .orderBy(desc(orders.id))
    .limit(limit + 1);
  return page(
    rows.map((r) => ({ ...r, number: r.number.toString(), total: r.total.toString() })),
    limit,
  );
}

export async function listPages(db: PrimaryDb) {
  return db
    .select({
      id: pages.id,
      path: pages.path,
      locale: pages.locale,
      title: pages.title,
      status: pages.status,
      updatedAt: pages.updatedAt,
      publishedVersionId: pages.publishedVersionId,
    })
    .from(pages)
    .orderBy(pages.locale, pages.path)
    .limit(500);
}

export async function listPromotions(db: PrimaryDb) {
  return db
    .select({
      id: promotions.id,
      code: promotions.code,
      name: promotions.name,
      active: promotions.active,
      startsAt: promotions.startsAt,
      endsAt: promotions.endsAt,
      usageLimit: promotions.usageLimit,
      usageCount: promotions.usageCount,
      definition: promotions.definition,
    })
    .from(promotions)
    .orderBy(desc(promotions.id))
    .limit(200);
}

export async function listStaff(db: PrimaryDb) {
  const rows = await db.execute<{
    id: string;
    email: string;
    name: string;
    status: string;
    last_login_at: string | null;
    roles: string[] | null;
  }>(sql`
    SELECT u.id, u.email, u.name, u.status, u.last_login_at,
           (SELECT array_agg(ur.role_name ORDER BY ur.role_name) FROM user_roles ur WHERE ur.user_id = u.id) AS roles
    FROM users u WHERE u.kind = 'staff' ORDER BY u.email LIMIT 500`);
  return rows.rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    status: r.status,
    lastLoginAt: r.last_login_at ? new Date(r.last_login_at) : null,
    roles: r.roles ?? [],
  }));
}

export async function listAudit(
  db: PrimaryDb,
  opts: { action?: string; actor?: string; limit?: number; before?: string },
) {
  const limit = clamp(opts.limit, 200, 50);
  const rows = await db
    .select()
    .from(auditLog)
    .where(
      and(
        opts.action ? ilike(auditLog.action, `${escapeLike(opts.action)}%`) : undefined,
        opts.actor ? eq(auditLog.actorLabel, opts.actor) : undefined,
        opts.before ? lt(auditLog.id, opts.before) : undefined,
      ),
    )
    .orderBy(desc(auditLog.id))
    .limit(limit + 1);
  return page(rows, limit);
}

export async function dashboard(db: PrimaryDb) {
  const r = await db.execute<{
    orders_24h: number;
    revenue_24h: string;
    pending: number;
    needs_attention: number;
    low_stock: number;
    products_active: number;
    emails_failed: number;
    emails_stuck: number;
  }>(sql`
    SELECT
      (SELECT count(*)::int FROM orders WHERE placed_at > now() - interval '24 hours') AS orders_24h,
      (SELECT COALESCE(sum(total), 0)::text FROM orders
        WHERE placed_at > now() - interval '24 hours' AND status IN ('paid','processing','shipped','delivered')) AS revenue_24h,
      (SELECT count(*)::int FROM orders WHERE status = 'pending_payment') AS pending,
      (SELECT count(*)::int FROM payment_events WHERE error = 'needs_attention') AS needs_attention,
      (SELECT count(*)::int FROM inventory_levels WHERE on_hand - reserved <= 5) AS low_stock,
      (SELECT count(*)::int FROM products WHERE status = 'active') AS products_active,
      (SELECT count(*)::int FROM notifications WHERE status = 'failed') AS emails_failed,
      (SELECT count(*)::int FROM notifications WHERE status IN ('queued','sending') AND created_at < now() - interval '10 minutes') AS emails_stuck`);
  const row = r.rows[0];
  const base = await db.execute<{ currency: string }>(
    sql`SELECT currency FROM orders ORDER BY id DESC LIMIT 1`,
  );
  return {
    orders24h: row?.orders_24h ?? 0,
    revenue24h: row?.revenue_24h ?? '0',
    revenueCurrency: base.rows[0]?.currency ?? null,
    pendingPayment: row?.pending ?? 0,
    paymentsNeedingAttention: row?.needs_attention ?? 0,
    lowStock: row?.low_stock ?? 0,
    activeProducts: row?.products_active ?? 0,
    emailsFailed: row?.emails_failed ?? 0,
    emailsStuck: row?.emails_stuck ?? 0,
  };
}

export async function orderConsent(db: PrimaryDb, orderId: string) {
  const r = await db.execute<{ consent: { analytics: boolean; marketing: boolean } }>(
    sql`SELECT consent FROM orders WHERE id = ${orderId}`,
  );
  return r.rows[0]?.consent ?? { analytics: false, marketing: false };
}

export async function orderPayments(db: PrimaryDb, orderId: string) {
  const r = await db.execute<{
    id: string;
    gateway: string;
    status: string;
    amount: string;
    captured: string;
    refunded: string;
    currency: string;
  }>(sql`
    SELECT id, gateway, status, amount::text, captured::text, refunded::text, currency
    FROM payments WHERE order_id = ${orderId} ORDER BY id`);
  return r.rows;
}

export async function setThemeSettings(
  db: PrimaryDb,
  tokens: Record<string, string>,
  actor: string,
  expectedVersion?: number,
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`INSERT INTO theme_settings (id) VALUES (true) ON CONFLICT DO NOTHING`);
    const cur = (
      await tx.execute<{ version: number }>(
        sql`SELECT version FROM theme_settings WHERE id = true FOR UPDATE`,
      )
    ).rows[0];
    if (expectedVersion !== undefined && cur && cur.version !== expectedVersion) return null;
    const res = await tx.execute<{ version: number }>(sql`
      UPDATE theme_settings SET tokens = ${JSON.stringify(tokens)}::jsonb, version = version + 1,
             updated_at = now(), updated_by = ${actor} WHERE id = true RETURNING version`);
    return res.rows[0]?.version ?? null;
  });
}

export async function getThemeSettings(db: PrimaryDb) {
  const r = await db.execute<{
    preset: string;
    tokens: Record<string, string>;
    version: number;
    updated_at: string;
    updated_by: string;
  }>(
    sql`SELECT preset, tokens, version, updated_at, updated_by FROM theme_settings WHERE id = true`,
  );
  const row = r.rows[0];
  return row
    ? {
        preset: row.preset,
        tokens: row.tokens,
        version: row.version,
        updatedAt: new Date(row.updated_at),
        updatedBy: row.updated_by,
      }
    : { preset: 'default', tokens: {}, version: 1, updatedAt: null, updatedBy: 'system' };
}

function page<T extends { id: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  return {
    items,
    nextCursor: rows.length > limit ? (items[items.length - 1]?.id ?? null) : null,
  };
}

/** Escape LIKE metacharacters so user text matches literally. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`).slice(0, 100);
}

export { productVariants, inventoryLevels, users };
