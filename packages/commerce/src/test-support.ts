import { randomUUID } from 'node:crypto';
import { createDb, schema, type Db } from '@sold/db';
import { migrate } from '@sold/db/migrate';
import { fileURLToPath } from 'node:url';

const migrationsDir = fileURLToPath(new URL('../../db/migrations', import.meta.url));

/** Migrated database handle for integration tests. */
export async function openMigrated(url: string, poolMax = 10): Promise<Db> {
  await migrate({ url, dir: migrationsDir });
  return createDb({ primaryUrl: url, poolMax });
}

export async function seedVariant(
  db: Db,
  opts: { onHand: number; price?: bigint; currency?: string; sku?: string; title?: string },
): Promise<{ productId: string; variantId: string; sku: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [product] = await db.primary
    .insert(schema.products)
    .values({ handle: `p-${suffix}`, title: opts.title ?? `Product ${suffix}`, status: 'active' })
    .returning();
  if (!product) throw new Error('seed failed');
  const sku = opts.sku ?? `SKU-${suffix}`;
  const [variant] = await db.primary
    .insert(schema.productVariants)
    .values({ productId: product.id, sku, title: 'Default' })
    .returning();
  if (!variant) throw new Error('seed failed');
  await db.primary.insert(schema.inventoryLevels).values({
    variantId: variant.id,
    onHand: opts.onHand,
  });
  await db.primary.insert(schema.variantPrices).values({
    variantId: variant.id,
    currency: opts.currency ?? 'AUD',
    amount: opts.price ?? 1000n,
  });
  return { productId: product.id, variantId: variant.id, sku };
}
