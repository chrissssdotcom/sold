import { sql } from '@sold/db';
import { InsufficientStockError, NotFoundError } from '../errors';
import type { DbOrTx, Tx } from '../types';
import type {
  InventoryReservationStrategy,
  ReserveRequest,
  ReserveResult,
  StockChange,
} from './strategy';

interface HeldRow extends Record<string, unknown> {
  id: string;
  variant_id: string;
  quantity: number;
  expires_at: Date;
}

/**
 * Authoritative reservation strategy. Correctness comes from one atomic conditional statement per
 * hold (`reserved = reserved + q WHERE on_hand - reserved >= q`): the row lock serialises contenders and
 * the predicate is re-evaluated after the lock, so two buyers can never both take the last unit. The
 * CHECK constraints in the schema are the second line of defence.
 *
 * Lock order is always reservation-row then level-row, and callers reserving several variants sort by
 * variant id (`reserveMany`), so concurrent multi-line checkouts cannot deadlock.
 */
export class PostgresReservationStrategy implements InventoryReservationStrategy {
  readonly name = 'postgres';

  async reserve(db: DbOrTx, req: ReserveRequest): Promise<ReserveResult> {
    return db.transaction(async (tx) => {
      const expiresAt = new Date(Date.now() + req.ttlSeconds * 1000);
      // Idempotency: the partial unique index makes a concurrent duplicate wait, then see DO NOTHING.
      const inserted = await tx.execute<HeldRow>(sql`
        INSERT INTO inventory_reservations (variant_id, owner_ref, quantity, expires_at)
        VALUES (${req.variantId}, ${req.ownerRef}, ${req.quantity}, ${expiresAt})
        ON CONFLICT (owner_ref, variant_id) WHERE status = 'held' DO NOTHING
        RETURNING id, variant_id, quantity, expires_at`);
      const fresh = inserted.rows[0];
      if (fresh) {
        await this.takeStock(tx, req.variantId, req.quantity);
        return {
          reservationId: fresh.id,
          created: true,
          quantity: req.quantity,
          expiresAt,
        };
      }

      // A live hold already exists: a retry (same quantity) or an adjustment (different quantity).
      const existing = (
        await tx.execute<HeldRow>(sql`
          SELECT id, variant_id, quantity, expires_at FROM inventory_reservations
          WHERE owner_ref = ${req.ownerRef} AND variant_id = ${req.variantId} AND status = 'held'
          FOR UPDATE`)
      ).rows[0];
      if (!existing) {
        // Settled between our INSERT and SELECT: take a fresh hold.
        return this.reserve(tx, req);
      }
      const delta = req.quantity - existing.quantity;
      if (delta > 0) await this.takeStock(tx, req.variantId, delta);
      if (delta < 0) await this.returnStock(tx, req.variantId, -delta);
      await tx.execute(sql`
        UPDATE inventory_reservations SET quantity = ${req.quantity}, expires_at = ${expiresAt}
        WHERE id = ${existing.id}`);
      return {
        reservationId: existing.id,
        created: false,
        quantity: req.quantity,
        expiresAt,
      };
    });
  }

  async release(db: DbOrTx, ownerRef: string, variantId?: string): Promise<StockChange[]> {
    return db.transaction(async (tx) => {
      const held = await this.lockHeld(
        tx,
        sql`owner_ref = ${ownerRef} ${variantId ? sql`AND variant_id = ${variantId}` : sql``}`,
      );
      return this.settle(tx, held, 'released');
    });
  }

  async commit(tx: Tx, ownerRef: string): Promise<StockChange[]> {
    const held = await this.lockHeld(tx, sql`owner_ref = ${ownerRef}`);
    for (const row of held) {
      await tx.execute(sql`
        UPDATE inventory_levels
        SET on_hand = GREATEST(on_hand - ${row.quantity}, 0), reserved = reserved - ${row.quantity}
        WHERE variant_id = ${row.variant_id}`);
    }
    if (held.length > 0) {
      await tx.execute(sql`
        UPDATE inventory_reservations SET status = 'committed', settled_at = now()
        WHERE id IN (${sql.join(
          held.map((h) => sql`${h.id}::uuid`),
          sql`, `,
        )})`);
    }
    return held.map((h) => ({ variantId: h.variant_id, quantity: h.quantity }));
  }

  async expire(db: DbOrTx, now: Date, limit: number): Promise<StockChange[]> {
    return db.transaction(async (tx) => {
      // SKIP LOCKED: concurrent sweepers (or a release racing us) never block each other.
      const due = (
        await tx.execute<HeldRow>(sql`
          SELECT id, variant_id, quantity, expires_at FROM inventory_reservations
          WHERE status = 'held' AND expires_at <= ${now}
          ORDER BY expires_at, variant_id
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED`)
      ).rows;
      return this.settle(tx, due, 'expired');
    });
  }

  /** Conditional decrement of availability. The single point where a unit changes hands. */
  private async takeStock(tx: Tx, variantId: string, quantity: number): Promise<void> {
    const res = await tx.execute(sql`
      UPDATE inventory_levels SET reserved = reserved + ${quantity}
      WHERE variant_id = ${variantId} AND (allow_backorder OR on_hand - reserved >= ${quantity})
      RETURNING on_hand, reserved`);
    if (res.rows.length > 0) return;
    const level = (
      await tx.execute<{ available: number }>(sql`
        SELECT on_hand - reserved AS available FROM inventory_levels WHERE variant_id = ${variantId}`)
    ).rows[0];
    if (!level) throw new NotFoundError('Inventory level', variantId);
    throw new InsufficientStockError(variantId, quantity, Math.max(level.available, 0));
  }

  private async returnStock(tx: Tx, variantId: string, quantity: number): Promise<void> {
    await tx.execute(sql`
      UPDATE inventory_levels SET reserved = reserved - ${quantity} WHERE variant_id = ${variantId}`);
  }

  private async lockHeld(tx: Tx, where: ReturnType<typeof sql>): Promise<HeldRow[]> {
    return (
      await tx.execute<HeldRow>(sql`
        SELECT id, variant_id, quantity, expires_at FROM inventory_reservations
        WHERE status = 'held' AND ${where}
        ORDER BY variant_id
        FOR UPDATE`)
    ).rows;
  }

  private async settle(
    tx: Tx,
    rows: HeldRow[],
    status: 'released' | 'expired',
  ): Promise<StockChange[]> {
    // Rows arrive ordered by variant id; return stock in that order (consistent lock order).
    const sorted = [...rows].sort((a, b) => a.variant_id.localeCompare(b.variant_id));
    for (const row of sorted) {
      await this.returnStock(tx, row.variant_id, row.quantity);
    }
    if (sorted.length > 0) {
      await tx.execute(sql`
        UPDATE inventory_reservations SET status = ${status}, settled_at = now()
        WHERE id IN (${sql.join(
          sorted.map((h) => sql`${h.id}::uuid`),
          sql`, `,
        )})`);
    }
    return sorted.map((r) => ({ variantId: r.variant_id, quantity: r.quantity }));
  }
}
