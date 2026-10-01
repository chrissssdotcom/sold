import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDb, sql, type Db } from '@sold/db';
import { createTestDatabase, type TestDatabase } from '@sold/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCommerce, type Commerce } from './commerce';
import { openMigrated, seedVariant } from './test-support';

/**
 * The reporting schema, tested the way Grafana uses it: as the read-only `sold_grafana` role, never as the owner.
 */
let testDb: TestDatabase;
let db: Db; // owner
let grafana: Db; // the reporting role
let commerce: Commerce;
const PASSWORD = 'grafana-test-password';

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = await openMigrated(testDb.url, 10);
  commerce = createCommerce();
  // Operators set the password out of band; migrations never contain one.
  await db.primary.execute(sql.raw(`ALTER ROLE sold_grafana LOGIN PASSWORD '${PASSWORD}'`));
  const url = new URL(testDb.url);
  url.username = 'sold_grafana';
  url.password = PASSWORD;
  grafana = createDb({ primaryUrl: url.toString(), poolMax: 3 });
});
afterAll(async () => {
  await grafana?.close();
  await db?.close();
  await testDb?.destroy();
});

const au = {
  line1: '1 George St',
  city: 'Sydney',
  region: 'NSW',
  postalCode: '2000',
  country: 'AU',
};
const asGrafana = async <T>(q: ReturnType<typeof sql>) =>
  (await grafana.primary.execute<T & Record<string, unknown>>(q)).rows;
let n = 0;

async function paidOrder(opts: { price: bigint; qty: number; email: string; currency?: string }) {
  const { variantId, productId } = await seedVariant(db, {
    onHand: 50,
    price: opts.price,
    currency: opts.currency ?? 'AUD',
    title: 'Reportable <thing>',
  });
  const cart = await commerce.carts.create(db.primary, { currency: opts.currency ?? 'AUD' });
  await commerce.carts.addItem(db.primary, cart.id, variantId, opts.qty);
  const { order } = await commerce.checkout.place(
    db.primary,
    { cartId: cart.id, email: opts.email, shippingAddress: au, shippingMethodId: 'standard' },
    `rep-${Date.now()}-${++n}`,
  );
  await db.primary.execute(sql`UPDATE orders SET status = 'paid' WHERE id = ${order.orderId}`);
  return { order, productId, variantId };
}

describe('the reporting role', () => {
  it('can read reporting views and nothing else', async () => {
    await paidOrder({ price: 2500n, qty: 2, email: 'private-person@example.test' });
    for (const view of [
      'daily_sales',
      'order_funnel',
      'top_products_30d',
      'inventory_health',
      'payments_by_gateway',
      'refunds_daily',
      'new_customers_daily',
      'email_queue',
    ])
      await expect(
        asGrafana(sql.raw(`SELECT * FROM reporting.${view} LIMIT 1`)),
        view,
      ).resolves.toBeDefined();
    // Base tables are not readable, even though the views over them are.
    for (const table of [
      'orders',
      'order_lines',
      'users',
      'sessions',
      'payments',
      'notifications',
      'audit_log',
      'extension_settings',
      'api_keys',
    ])
      await expect(
        asGrafana(sql.raw(`SELECT 1 FROM public.${table} LIMIT 1`)),
        table,
      ).rejects.toThrow();
  });

  it('cannot write, create, or change anything (read-only by role setting and by privilege)', async () => {
    await expect(asGrafana(sql`CREATE TABLE public.x (a int)`)).rejects.toThrow();
    await expect(asGrafana(sql`CREATE TABLE reporting.x (a int)`)).rejects.toThrow();
    await expect(asGrafana(sql`UPDATE reporting.daily_sales SET orders = 0`)).rejects.toThrow();
    await expect(asGrafana(sql`INSERT INTO orders DEFAULT VALUES`)).rejects.toThrow();
    await expect(asGrafana(sql`DROP VIEW reporting.daily_sales`)).rejects.toThrow();
    await expect(asGrafana(sql`ALTER ROLE sold_grafana SUPERUSER`)).rejects.toThrow();
    // The role's own settings (the application client sends its own startup timeouts, so inspect the role, not a session).
    const [role] = (
      await db.primary.execute<{
        config: string[];
        super: boolean;
        createrole: boolean;
        createdb: boolean;
      }>(
        sql`SELECT rolconfig AS config, rolsuper AS super, rolcreaterole AS createrole, rolcreatedb AS createdb FROM pg_roles WHERE rolname = 'sold_grafana'`,
      )
    ).rows;
    expect(role!.config).toEqual(
      expect.arrayContaining(['statement_timeout=30s', 'default_transaction_read_only=on']),
    );
    expect([role!.super, role!.createrole, role!.createdb]).toEqual([false, false, false]);
  });

  it('a runaway query is cut off by a statement timeout, not left to hurt the database', async () => {
    const started = Date.now();
    await grafana.primary.execute(sql`SET statement_timeout = '300ms'`); // the role may shorten its own limit
    const err = await asGrafana(sql`SELECT pg_sleep(5)`).catch((e: unknown) => e);
    expect(String((err as { cause?: unknown }).cause ?? err)).toMatch(/statement timeout/i);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('no reporting column can carry personal data', async () => {
    const cols = await asGrafana<{ table_name: string; column_name: string }>(
      sql`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'reporting' ORDER BY 1, 2`,
    );
    expect(cols.length).toBeGreaterThan(20);
    const risky = cols.filter((c) =>
      /(email|address|phone|ip_|_ip|token|password|secret|customer_id|user_id|actor|session|cart_id|first_name|last_name|full_name|^name$)/i.test(
        c.column_name,
      ),
    );
    expect(risky).toEqual([]);
  });
});

describe('the numbers are right', () => {
  it('daily_sales reports the order exactly, in major units, and ignores unpaid orders', async () => {
    const before = await asGrafana<{ orders: string; total_minor: string }>(
      sql`SELECT COALESCE(sum(orders),0)::text AS orders, COALESCE(sum(total_minor),0)::text AS total_minor FROM reporting.daily_sales WHERE currency = 'AUD'`,
    );
    const { order } = await paidOrder({ price: 1999n, qty: 3, email: 'sales@example.test' });
    // An unpaid order must not count.
    const { variantId } = await seedVariant(db, { onHand: 5, price: 1000n });
    const cart = await commerce.carts.create(db.primary, { currency: 'AUD' });
    await commerce.carts.addItem(db.primary, cart.id, variantId, 1);
    await commerce.checkout.place(
      db.primary,
      {
        cartId: cart.id,
        email: 'u@example.test',
        shippingAddress: au,
        shippingMethodId: 'standard',
      },
      `rep-unpaid-${Date.now()}`,
    );

    const after = await asGrafana<{ orders: string; total_minor: string }>(
      sql`SELECT COALESCE(sum(orders),0)::text AS orders, COALESCE(sum(total_minor),0)::text AS total_minor FROM reporting.daily_sales WHERE currency = 'AUD'`,
    );
    expect(BigInt(after[0]!.orders) - BigInt(before[0]!.orders)).toBe(1n);
    expect(BigInt(after[0]!.total_minor) - BigInt(before[0]!.total_minor)).toBe(order.total.amount);
    const [major] = await asGrafana<{ v: string }>(
      sql`SELECT reporting.major(1999, 'AUD')::text AS v`,
    );
    expect(major!.v).toBe('19.99');
  });

  it('currency exponents: JPY has none, KWD has three', async () => {
    const rows = await asGrafana<{ jpy: string; kwd: string; aud: string }>(
      sql`SELECT reporting.major(1500, 'JPY')::text AS jpy, reporting.major(1500, 'KWD')::text AS kwd, reporting.major(1500, 'AUD')::text AS aud`,
    );
    expect(rows[0]).toEqual({ jpy: '1500', kwd: '1.500', aud: '15.00' });
  });

  it('top products and inventory health reflect the catalogue; funnel counts statuses', async () => {
    const { productId } = await paidOrder({ price: 700n, qty: 4, email: 'top@example.test' });
    const top = await asGrafana<{ units: string }>(
      sql`SELECT units::text FROM reporting.top_products_30d WHERE product_id = ${productId}`,
    );
    expect(top[0]?.units).toBe('4');
    const inv = await asGrafana<{ available: number }>(
      sql`SELECT available FROM reporting.inventory_health WHERE product = 'Reportable <thing>' LIMIT 1`,
    );
    expect(inv.length).toBeGreaterThan(0);
    const funnel = await asGrafana<{ placed: string; paid: string }>(
      sql`SELECT sum(placed)::text AS placed, sum(paid)::text AS paid FROM reporting.order_funnel`,
    );
    expect(Number(funnel[0]!.placed)).toBeGreaterThanOrEqual(Number(funnel[0]!.paid));
  });
});

describe('the Grafana dashboards', () => {
  const dir = fileURLToPath(new URL('../../../ops/grafana/dashboards/', import.meta.url));
  interface Target {
    refId: string;
    rawSql?: string;
    datasource?: { uid?: string };
  }
  interface Panel {
    id: number;
    title: string;
    targets?: Target[];
    datasource?: { uid?: string };
  }
  const dashboards = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({
      file: f,
      json: JSON.parse(readFileSync(dir + f, 'utf8')) as {
        uid: string;
        title: string;
        panels: Panel[];
      },
    }));

  it('are valid, uniquely identified, and every panel has an id and a title', () => {
    expect(dashboards.length).toBeGreaterThanOrEqual(2);
    expect(new Set(dashboards.map((d) => d.json.uid)).size).toBe(dashboards.length);
    for (const d of dashboards) {
      const ids = d.json.panels.map((p) => p.id);
      expect(new Set(ids).size, d.file).toBe(ids.length);
      for (const p of d.json.panels)
        expect(p.title.length, `${d.file} #${p.id}`).toBeGreaterThan(2);
    }
  });

  /** Expand the few Grafana macros the dashboards use, the way Grafana would for a 30 day window. */
  const expand = (q: string) =>
    q
      .replace(/\$__timeFilter\(([^)]*)\)/g, "$1 BETWEEN now() - interval '30 days' AND now()")
      .replace(/\$__timeFrom\(\)/g, "now() - interval '30 days'")
      .replace(/\$__timeTo\(\)/g, 'now()');

  it('every SQL panel runs against the real schema as the read-only role, and reads only reporting.*', async () => {
    await paidOrder({ price: 1250n, qty: 1, email: 'dash@example.test' }); // so the queries have something to chew on
    let ran = 0;
    for (const d of dashboards) {
      for (const p of d.json.panels)
        for (const t of p.targets ?? []) {
          if (!t.rawSql) continue; // Prometheus panels are exercised by the scale tests, not here
          const q = expand(t.rawSql);
          expect(q, `${d.file} / ${p.title}`).not.toMatch(/\bFROM\s+(?!reporting\.)(?!\()\w+/i);
          await expect(
            asGrafana(sql.raw(q)),
            `${d.file} / ${p.title} / ${t.refId}`,
          ).resolves.toBeDefined();
          ran += 1;
        }
    }
    expect(ran).toBeGreaterThanOrEqual(12);
  });

  it('the sales dashboard shows revenue for the order we just made', async () => {
    const sales = dashboards.find((d) => d.json.uid === 'sold-sales-ops')!;
    const revenue = sales.json.panels.find((p) => p.title.startsWith('Revenue, last 30'))!;
    const rows = await asGrafana<{ currency: string; revenue: string }>(
      sql.raw(expand(revenue.targets![0]!.rawSql!)),
    );
    expect(rows.find((r) => r.currency === 'AUD')).toBeTruthy();
  });
});
