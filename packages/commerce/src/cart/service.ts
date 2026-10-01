import { and, eq, schema, sql } from '@sold/db';
import {
  ConflictError,
  InsufficientStockError,
  NotFoundError,
  ValidationError,
  VetoError,
} from '../errors';
import { noHooks, type HookRunner } from '../hooks';
import type { DbOrTx } from '../types';

const { carts, cartLines } = schema;

export interface CartLineRecord {
  id: string;
  variantId: string;
  quantity: number;
}

export interface CartRecord {
  id: string;
  customerId: string | null;
  currency: string;
  status: 'open' | 'converted' | 'abandoned';
  version: number;
  couponCodes: string[];
  expiresAt: Date;
  lines: CartLineRecord[];
}

export interface CartServiceOptions {
  hooks?: HookRunner;
  maxLineQuantity?: number;
  maxLines?: number;
  ttlDays?: number;
}

/**
 * Cart mutations. Every mutation locks the cart row (`FOR UPDATE`) so concurrent tabs serialise instead of
 * losing updates, and bumps `version`; callers may pass `expectedVersion` for optimistic concurrency.
 * Stock is checked softly here (so shoppers get early feedback) but only *held* at checkout, so a
 * hoarder cannot lock up a limited drop with abandoned carts.
 */
export class CartService {
  private readonly hooks: HookRunner;
  private readonly maxLineQuantity: number;
  private readonly maxLines: number;
  private readonly ttlDays: number;

  constructor(opts: CartServiceOptions = {}) {
    this.hooks = opts.hooks ?? noHooks;
    this.maxLineQuantity = opts.maxLineQuantity ?? 99;
    this.maxLines = opts.maxLines ?? 100;
    this.ttlDays = opts.ttlDays ?? 30;
  }

  async create(
    db: DbOrTx,
    input: { currency: string; customerId?: string | null },
  ): Promise<CartRecord> {
    if (!/^[A-Z]{3}$/.test(input.currency))
      throw new ValidationError('currency must be an ISO-4217 code');
    const [row] = await db
      .insert(carts)
      .values({
        currency: input.currency,
        customerId: input.customerId ?? null,
        expiresAt: this.expiry(),
      })
      .returning({ id: carts.id });
    if (!row) throw new Error('cart insert failed');
    return this.get(db, row.id);
  }

  async get(db: DbOrTx, cartId: string): Promise<CartRecord> {
    const [cart] = await db.select().from(carts).where(eq(carts.id, cartId)).limit(1);
    if (!cart) throw new NotFoundError('Cart', cartId);
    const lines = await db
      .select({ id: cartLines.id, variantId: cartLines.variantId, quantity: cartLines.quantity })
      .from(cartLines)
      .where(eq(cartLines.cartId, cartId))
      .orderBy(cartLines.createdAt, cartLines.id);
    return {
      id: cart.id,
      customerId: cart.customerId,
      currency: cart.currency.trim(),
      status: cart.status as CartRecord['status'],
      version: cart.version,
      couponCodes: cart.couponCodes,
      expiresAt: cart.expiresAt,
      lines,
    };
  }

  /** Add `quantity` of a variant (adds to any existing line). */
  async addItem(
    db: DbOrTx,
    cartId: string,
    variantId: string,
    quantity: number,
    opts: { expectedVersion?: number } = {},
  ): Promise<CartRecord> {
    this.assertQuantity(quantity, 1);
    // Extensions decide first (purchase limits, drop rules): no cart lock is held while they run.
    const decision = await this.hooks.run('cart.item.adding', { cartId, variantId, quantity });
    if (decision.veto) throw new VetoError(decision.veto.code, decision.veto.message);
    const requested = decision.payload.quantity;
    this.assertQuantity(requested, 0);

    return db.transaction(async (tx) => {
      const cart = await this.lockOpen(tx, cartId, opts.expectedVersion);
      const variant = await this.sellable(tx, variantId, cart.currency);
      const existing = await tx
        .select({ id: cartLines.id, quantity: cartLines.quantity })
        .from(cartLines)
        .where(and(eq(cartLines.cartId, cartId), eq(cartLines.variantId, variantId)));
      const current = existing[0]?.quantity ?? 0;
      const total = current + requested;
      if (requested === 0) return this.get(tx, cartId); // an interceptor reduced it to nothing
      if (total > this.maxLineQuantity)
        throw new ValidationError(`At most ${this.maxLineQuantity} of one item per cart`);
      if (current === 0) {
        const count = await tx.execute<{ n: string }>(
          sql`SELECT count(*) AS n FROM cart_lines WHERE cart_id = ${cartId}`,
        );
        if (Number(count.rows[0]?.n ?? 0) >= this.maxLines)
          throw new ValidationError(`A cart holds at most ${this.maxLines} different items`);
      }
      await this.softStockCheck(tx, variantId, total, variant.allowBackorder);
      await tx
        .insert(cartLines)
        .values({ cartId, variantId, quantity: total })
        .onConflictDoUpdate({
          target: [cartLines.cartId, cartLines.variantId],
          set: { quantity: total, updatedAt: new Date() },
        });
      await this.touch(tx, cartId);
      return this.get(tx, cartId);
    });
  }

  /** Set an absolute quantity; 0 removes the line. */
  async setQuantity(
    db: DbOrTx,
    cartId: string,
    variantId: string,
    quantity: number,
    opts: { expectedVersion?: number } = {},
  ): Promise<CartRecord> {
    this.assertQuantity(quantity, 0);
    return db.transaction(async (tx) => {
      const cart = await this.lockOpen(tx, cartId, opts.expectedVersion);
      if (quantity === 0) {
        await tx
          .delete(cartLines)
          .where(and(eq(cartLines.cartId, cartId), eq(cartLines.variantId, variantId)));
      } else {
        const variant = await this.sellable(tx, variantId, cart.currency);
        await this.softStockCheck(tx, variantId, quantity, variant.allowBackorder);
        const updated = await tx
          .update(cartLines)
          .set({ quantity, updatedAt: new Date() })
          .where(and(eq(cartLines.cartId, cartId), eq(cartLines.variantId, variantId)))
          .returning({ id: cartLines.id });
        if (updated.length === 0) throw new NotFoundError('Cart line', variantId);
      }
      await this.touch(tx, cartId);
      return this.get(tx, cartId);
    });
  }

  async applyCoupon(db: DbOrTx, cartId: string, code: string): Promise<CartRecord> {
    const normalized = code.trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,64}$/.test(normalized)) throw new ValidationError('Invalid coupon code');
    return db.transaction(async (tx) => {
      const cart = await this.lockOpen(tx, cartId);
      if (!cart.couponCodes.includes(normalized)) {
        if (cart.couponCodes.length >= 5) throw new ValidationError('Too many coupon codes');
        await tx
          .update(carts)
          .set({ couponCodes: [...cart.couponCodes, normalized] })
          .where(eq(carts.id, cartId));
      }
      await this.touch(tx, cartId);
      return this.get(tx, cartId);
    });
  }

  async removeCoupon(db: DbOrTx, cartId: string, code: string): Promise<CartRecord> {
    const normalized = code.trim().toLowerCase();
    return db.transaction(async (tx) => {
      const cart = await this.lockOpen(tx, cartId);
      await tx
        .update(carts)
        .set({ couponCodes: cart.couponCodes.filter((c) => c !== normalized) })
        .where(eq(carts.id, cartId));
      await this.touch(tx, cartId);
      return this.get(tx, cartId);
    });
  }

  /**
   * Merge a guest cart into a customer's cart at sign-in: quantities add (capped), guest cart is abandoned.
   * Both rows are locked in id order so two concurrent merges cannot deadlock.
   */
  async merge(db: DbOrTx, fromCartId: string, intoCartId: string): Promise<CartRecord> {
    if (fromCartId === intoCartId) return this.get(db, intoCartId);
    return db.transaction(async (tx) => {
      const [first, second] = [fromCartId, intoCartId].sort();
      await tx.execute(
        sql`SELECT id FROM carts WHERE id IN (${first}, ${second}) ORDER BY id FOR UPDATE`,
      );
      const from = await this.get(tx, fromCartId);
      const into = await this.get(tx, intoCartId);
      if (into.status !== 'open') throw new ConflictError('cart_closed', 'Target cart is not open');
      if (from.currency !== into.currency) return into; // never mix currencies: keep the customer's cart
      for (const line of from.lines) {
        await tx
          .insert(cartLines)
          .values({
            cartId: intoCartId,
            variantId: line.variantId,
            quantity: Math.min(line.quantity, this.maxLineQuantity),
          })
          .onConflictDoUpdate({
            target: [cartLines.cartId, cartLines.variantId],
            set: {
              quantity: sql`LEAST(${cartLines.quantity} + ${line.quantity}, ${this.maxLineQuantity})`,
              updatedAt: new Date(),
            },
          });
      }
      await tx.update(carts).set({ status: 'abandoned' }).where(eq(carts.id, fromCartId));
      await this.touch(tx, intoCartId);
      return this.get(tx, intoCartId);
    });
  }

  /**
   * Attach an anonymous cart to a customer who just signed in. If they already have an open cart in the same currency the two
   * are merged (quantities add, capped) and that cart wins; otherwise the guest cart simply becomes theirs.
   */
  async claim(db: DbOrTx, guestCartId: string, customerId: string): Promise<CartRecord> {
    return db.transaction(async (tx) => {
      const guest = await this.get(tx, guestCartId);
      if (guest.status !== 'open' || guest.customerId) return guest;
      const existing = await tx.execute<{ id: string }>(
        sql`SELECT id FROM carts WHERE customer_id = ${customerId} AND status = 'open' AND currency = ${guest.currency} AND id <> ${guestCartId} ORDER BY updated_at DESC LIMIT 1`,
      );
      const mine = existing.rows[0]?.id;
      if (mine) return this.merge(tx, guestCartId, mine);
      await tx.update(carts).set({ customerId }).where(eq(carts.id, guestCartId));
      return this.get(tx, guestCartId);
    });
  }

  /** Mark converted. Called by checkout inside the order transaction. */
  async markConverted(tx: DbOrTx, cartId: string): Promise<void> {
    await tx.update(carts).set({ status: 'converted' }).where(eq(carts.id, cartId));
  }

  /** Lock the cart row and require it to be open, unexpired and (optionally) at an expected version. */
  async lockOpen(tx: DbOrTx, cartId: string, expectedVersion?: number): Promise<CartRecord> {
    const rows = await tx.execute<{ id: string }>(
      sql`SELECT id FROM carts WHERE id = ${cartId} FOR UPDATE`,
    );
    if (rows.rows.length === 0) throw new NotFoundError('Cart', cartId);
    const cart = await this.get(tx, cartId);
    if (cart.status !== 'open')
      throw new ConflictError('cart_closed', 'This cart is no longer open');
    if (cart.expiresAt.getTime() < Date.now())
      throw new ConflictError('cart_expired', 'This cart has expired');
    if (expectedVersion !== undefined && cart.version !== expectedVersion)
      throw new ConflictError('cart_version_conflict', 'The cart changed; reload and retry', {
        expected: expectedVersion,
        actual: cart.version,
      });
    return cart;
  }

  private async touch(tx: DbOrTx, cartId: string): Promise<void> {
    await tx
      .update(carts)
      .set({ version: sql`${carts.version} + 1`, expiresAt: this.expiry() })
      .where(eq(carts.id, cartId));
  }

  private expiry(): Date {
    return new Date(Date.now() + this.ttlDays * 86_400_000);
  }

  private assertQuantity(quantity: number, min: number): void {
    if (!Number.isInteger(quantity) || quantity < min || quantity > this.maxLineQuantity)
      throw new ValidationError(
        `Quantity must be a whole number from ${min} to ${this.maxLineQuantity}`,
      );
  }

  /** Variant must be active, its product active, and priced in the cart's currency. */
  private async sellable(
    tx: DbOrTx,
    variantId: string,
    currency: string,
  ): Promise<{ allowBackorder: boolean }> {
    const rows = await tx.execute<{ allow_backorder: boolean | null; has_price: boolean }>(sql`
      SELECT il.allow_backorder,
             EXISTS (SELECT 1 FROM variant_prices vp WHERE vp.variant_id = v.id AND vp.currency = ${currency}) AS has_price
      FROM product_variants v
      JOIN products p ON p.id = v.product_id
      LEFT JOIN inventory_levels il ON il.variant_id = v.id
      WHERE v.id = ${variantId} AND v.status = 'active' AND p.status = 'active'`);
    const row = rows.rows[0];
    if (!row) throw new NotFoundError('Variant', variantId);
    if (!row.has_price)
      throw new ValidationError(`This item is not sold in ${currency}`, { variantId, currency });
    return { allowBackorder: row.allow_backorder ?? false };
  }

  private async softStockCheck(
    tx: DbOrTx,
    variantId: string,
    wanted: number,
    backorder: boolean,
  ): Promise<void> {
    if (backorder) return;
    const rows = await tx.execute<{ available: number }>(
      sql`SELECT on_hand - reserved AS available FROM inventory_levels WHERE variant_id = ${variantId}`,
    );
    const available = rows.rows[0]?.available ?? 0;
    if (available < wanted)
      throw new InsufficientStockError(variantId, wanted, Math.max(available, 0));
  }
}
