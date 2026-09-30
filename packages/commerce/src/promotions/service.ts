import { and, eq, inArray, or, schema, sql, type PrimaryDb } from '@sold/db';
import { parsePromotion, type PromotionDef } from '../pricing';
import { ConflictError, ValidationError } from '../errors';
import type { DbOrTx } from '../types';

const { promotions } = schema;

export interface StoredPromotion {
  def: PromotionDef;
  usageCount: number;
}

/** Promotion admin operations and the read used by pricing. Definitions are validated by the pricing engine's schema. */
export class PromotionService {
  /** Create a promotion. `input` uses the pricing schema; `id` is assigned by the database. */
  async create(db: PrimaryDb, input: Record<string, unknown>): Promise<string> {
    // Validate with a placeholder id so the whole definition (kind-specific fields, dates) is checked.
    const def = parsePromotion({ ...input, id: 'pending' });
    const { id: _id, name, code, startsAt, endsAt, usageLimit, perCustomerLimit, ...rest } = def;
    void _id;
    const definition = JSON.parse(
      JSON.stringify(rest, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
    ) as Record<string, unknown>;
    // Money instances serialise through toJSON ({amount, currency}); bigint amounts were stringified above.
    try {
      const [row] = await db
        .insert(promotions)
        .values({
          name,
          code: code ? code.trim().toLowerCase() : null,
          startsAt,
          endsAt,
          usageLimit,
          perCustomerLimit,
          definition,
        })
        .returning({ id: promotions.id });
      if (!row) throw new Error('insert failed');
      return row.id;
    } catch (error) {
      if (String((error as { cause?: { code?: string } }).cause?.code) === '23505')
        throw new ConflictError('code_taken', 'That coupon code is already in use');
      throw error;
    }
  }

  async setActive(db: PrimaryDb, id: string, active: boolean): Promise<void> {
    await db.update(promotions).set({ active }).where(eq(promotions.id, id));
  }

  /**
   * Promotions that could apply to a cart: automatic ones plus those whose code the shopper entered. One query;
   * the time window is re-checked by the pure engine, this only bounds the rows read.
   */
  async candidates(
    db: DbOrTx,
    couponCodes: readonly string[],
    now: Date,
    onInvalid?: (id: string, error: unknown) => void,
  ): Promise<PromotionDef[]> {
    const codes = couponCodes.map((c) => c.trim().toLowerCase());
    const rows = await db
      .select()
      .from(promotions)
      .where(
        and(
          eq(promotions.active, true),
          or(
            sql`${promotions.code} IS NULL`,
            codes.length > 0 ? inArray(promotions.code, codes) : sql`false`,
          ),
          sql`(${promotions.startsAt} IS NULL OR ${promotions.startsAt} <= ${now})`,
          sql`(${promotions.endsAt} IS NULL OR ${promotions.endsAt} > ${now})`,
        ),
      );
    const out: PromotionDef[] = [];
    for (const row of rows) {
      try {
        out.push(
          parsePromotion({
            ...(row.definition as Record<string, unknown>),
            id: row.id,
            name: row.name,
            code: row.code,
            startsAt: row.startsAt,
            endsAt: row.endsAt,
            usageLimit: row.usageLimit,
            perCustomerLimit: row.perCustomerLimit,
          }),
        );
      } catch (error) {
        // One malformed promotion must never break checkout for everyone else.
        onInvalid?.(row.id, error);
      }
    }
    return out;
  }

  /** Redemptions so far for a promotion (admin reporting). */
  async usage(db: DbOrTx, id: string): Promise<number> {
    const [row] = await db
      .select({ n: promotions.usageCount })
      .from(promotions)
      .where(eq(promotions.id, id));
    if (!row) throw new ValidationError('Unknown promotion');
    return row.n;
  }
}
