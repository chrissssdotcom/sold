import { z } from 'zod';
import { Money } from '@sold/core';
import { and, asc, desc, eq, inArray, schema, sql, type PrimaryDb, type ReplicaDb } from '@sold/db';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import type { DbOrTx } from '../types';

const { products, productVariants, variantPrices, inventoryLevels } = schema;

const handle = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase letters, digits and single dashes');

export const variantInput = z.object({
  sku: z.string().min(1).max(64),
  title: z.string().max(200).default(''),
  options: z.record(z.string(), z.string()).default({}),
  weightGrams: z.number().int().min(0).default(0),
  /** Price per currency in minor units (as decimal strings, so no float ever carries money). */
  prices: z
    .array(
      z.object({
        currency: z.string().length(3),
        amount: z.string().regex(/^\d+$/),
        compareAt: z.string().regex(/^\d+$/).optional(),
      }),
    )
    .min(1),
  onHand: z.number().int().min(0).default(0),
  allowBackorder: z.boolean().default(false),
});

export const productInput = z.object({
  handle,
  title: z.string().min(1).max(300),
  description: z.string().max(20_000).default(''),
  status: z.enum(['draft', 'active', 'archived']).default('draft'),
  tags: z.array(z.string().min(1).max(60)).max(50).default([]),
  attributes: z.record(z.string(), z.unknown()).default({}),
  variants: z.array(variantInput).min(1).max(250),
});
export type ProductInput = z.input<typeof productInput>;

export interface CatalogVariant {
  id: string;
  sku: string;
  title: string;
  options: Record<string, string>;
  weightGrams: number;
  prices: { currency: string; amount: Money; compareAt: Money | null }[];
}

export interface CatalogProduct {
  id: string;
  handle: string;
  title: string;
  description: string;
  status: string;
  tags: string[];
  attributes: Record<string, unknown>;
  variants: CatalogVariant[];
}

export interface ProductPage {
  items: Omit<CatalogProduct, 'variants'>[];
  /** Opaque keyset cursor; pass back to fetch the next page. Null on the last page. */
  nextCursor: string | null;
}

function encodeCursor(id: string): string {
  return Buffer.from(id).toString('base64url');
}
function decodeCursor(cursor: string): string {
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new ValidationError('Invalid cursor');
  return id;
}

/** Catalog reads take a replica handle (storefront traffic must never load the primary); writes take the primary. */
export class CatalogService {
  async create(db: PrimaryDb, input: ProductInput): Promise<CatalogProduct> {
    const parsed = productInput.parse(input);
    const skus = parsed.variants.map((v) => v.sku);
    if (new Set(skus).size !== skus.length) throw new ValidationError('Duplicate SKU in request');
    const productId = await db.transaction(async (tx) => {
      const taken = await tx
        .select({ handle: products.handle })
        .from(products)
        .where(eq(products.handle, parsed.handle));
      if (taken.length > 0)
        throw new ConflictError('handle_taken', 'That handle is already in use');
      const existingSkus = await tx
        .select({ sku: productVariants.sku })
        .from(productVariants)
        .where(inArray(productVariants.sku, skus));
      if (existingSkus.length > 0)
        throw new ConflictError('sku_taken', 'A SKU is already in use', {
          skus: existingSkus.map((s) => s.sku),
        });

      const [product] = await tx
        .insert(products)
        .values({
          handle: parsed.handle,
          title: parsed.title,
          description: parsed.description,
          status: parsed.status,
          tags: parsed.tags,
          attributes: parsed.attributes,
        })
        .returning({ id: products.id });
      if (!product) throw new Error('insert failed');
      // Bulk inserts: one statement per table regardless of variant count.
      const variants = await tx
        .insert(productVariants)
        .values(
          parsed.variants.map((v, position) => ({
            productId: product.id,
            sku: v.sku,
            title: v.title,
            options: v.options,
            weightGrams: v.weightGrams,
            position,
          })),
        )
        .returning({ id: productVariants.id, sku: productVariants.sku });
      const idBySku = new Map(variants.map((v) => [v.sku, v.id]));
      await tx.insert(variantPrices).values(
        parsed.variants.flatMap((v) =>
          v.prices.map((p) => {
            Money.of(BigInt(p.amount), p.currency); // validates the currency code
            return {
              variantId: idBySku.get(v.sku) as string,
              currency: p.currency,
              amount: BigInt(p.amount),
              compareAt: p.compareAt ? BigInt(p.compareAt) : null,
            };
          }),
        ),
      );
      await tx.insert(inventoryLevels).values(
        parsed.variants.map((v) => ({
          variantId: idBySku.get(v.sku) as string,
          onHand: v.onHand,
          allowBackorder: v.allowBackorder,
        })),
      );
      return product.id;
    });
    return this.getById(db, productId);
  }

  async setStatus(
    db: PrimaryDb,
    productId: string,
    status: 'draft' | 'active' | 'archived',
  ): Promise<void> {
    const res = await db
      .update(products)
      .set({ status })
      .where(eq(products.id, productId))
      .returning({ id: products.id });
    if (res.length === 0) throw new NotFoundError('Product', productId);
  }

  async setPrice(
    db: DbOrTx,
    variantId: string,
    price: { currency: string; amount: Money; compareAt?: Money | null },
  ): Promise<void> {
    if (price.amount.currency !== price.currency)
      throw new ValidationError('Price currency mismatch');
    await db
      .insert(variantPrices)
      .values({
        variantId,
        currency: price.currency,
        amount: price.amount.amount,
        compareAt: price.compareAt?.amount ?? null,
      })
      .onConflictDoUpdate({
        target: [variantPrices.variantId, variantPrices.currency],
        set: {
          amount: price.amount.amount,
          compareAt: price.compareAt?.amount ?? null,
          updatedAt: new Date(),
        },
      });
  }

  getById(db: PrimaryDb | ReplicaDb, id: string): Promise<CatalogProduct> {
    return this.load(db, eq(products.id, id), id);
  }

  /** Storefront read: active products only. Three queries total (product, variants, prices), independent of variant count. */
  getActiveByHandle(db: ReplicaDb | PrimaryDb, productHandle: string): Promise<CatalogProduct> {
    return this.load(
      db,
      and(eq(products.handle, productHandle), eq(products.status, 'active')),
      productHandle,
    );
  }

  private async load(
    db: PrimaryDb | ReplicaDb,
    where: ReturnType<typeof eq> | ReturnType<typeof and>,
    ref: string,
  ): Promise<CatalogProduct> {
    const [product] = await db.select().from(products).where(where).limit(1);
    if (!product) throw new NotFoundError('Product', ref);
    const variants = await db
      .select()
      .from(productVariants)
      .where(and(eq(productVariants.productId, product.id), eq(productVariants.status, 'active')))
      .orderBy(asc(productVariants.position));
    const prices = variants.length
      ? await db
          .select()
          .from(variantPrices)
          .where(
            inArray(
              variantPrices.variantId,
              variants.map((v) => v.id),
            ),
          )
      : [];
    return {
      id: product.id,
      handle: product.handle,
      title: product.title,
      description: product.description,
      status: product.status,
      tags: product.tags,
      attributes: product.attributes as Record<string, unknown>,
      variants: variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        title: v.title,
        options: v.options as Record<string, string>,
        weightGrams: v.weightGrams,
        prices: prices
          .filter((p) => p.variantId === v.id)
          .map((p) => ({
            currency: p.currency,
            amount: Money.of(p.amount, p.currency),
            compareAt: p.compareAt === null ? null : Money.of(p.compareAt, p.currency),
          })),
      })),
    };
  }

  /** Keyset pagination (never OFFSET): stable under inserts and O(page) at any depth, using products_active_created_idx. */
  async listActive(
    db: ReplicaDb | PrimaryDb,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<ProductPage> {
    const limit = Math.min(Math.max(opts.limit ?? 24, 1), 100);
    const afterId = opts.cursor ? decodeCursor(opts.cursor) : null;
    // Row comparison against the cursor row itself (not a JS Date): timestamps keep microsecond precision.
    const rows = await db
      .select()
      .from(products)
      .where(
        and(
          eq(products.status, 'active'),
          afterId
            ? sql`(${products.createdAt}, ${products.id}) < (SELECT created_at, id FROM products WHERE id = ${afterId})`
            : sql`true`,
        ),
      )
      .orderBy(desc(products.createdAt), desc(products.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((p) => ({
        id: p.id,
        handle: p.handle,
        title: p.title,
        description: p.description,
        status: p.status,
        tags: p.tags,
        attributes: p.attributes as Record<string, unknown>,
      })),
      nextCursor: rows.length > limit && last ? encodeCursor(last.id) : null,
    };
  }
}
