import { sql } from '@sold/db';
import { NotFoundError, ValidationError } from '../errors';
import type { DbOrTx } from '../types';
import type { InventoryGate } from './gate';
import type { InventoryReservationStrategy, ReserveResult, StockChange } from './strategy';

export interface StockLevel {
  variantId: string;
  onHand: number;
  reserved: number;
  available: number;
  allowBackorder: boolean;
}

export interface InventoryServiceOptions {
  strategy: InventoryReservationStrategy;
  /** Present when the strategy is gated: stock adjustments must invalidate its counters. */
  gate?: InventoryGate;
  /** Default hold time for a cart line. Checkout extends it. */
  defaultTtlSeconds?: number;
}

export class InventoryService {
  private readonly strategy: InventoryReservationStrategy;
  private readonly gate: InventoryGate | undefined;
  private readonly ttl: number;

  constructor(opts: InventoryServiceOptions) {
    this.strategy = opts.strategy;
    this.gate = opts.gate;
    this.ttl = opts.defaultTtlSeconds ?? 15 * 60;
  }

  get strategyName(): string {
    return this.strategy.name;
  }

  async level(db: DbOrTx, variantId: string): Promise<StockLevel> {
    const rows = (
      await db.execute<{
        on_hand: number;
        reserved: number;
        allow_backorder: boolean;
      }>(
        sql`SELECT on_hand, reserved, allow_backorder FROM inventory_levels WHERE variant_id = ${variantId}`,
      )
    ).rows;
    const row = rows[0];
    if (!row) throw new NotFoundError('Inventory level', variantId);
    return {
      variantId,
      onHand: row.on_hand,
      reserved: row.reserved,
      available: row.allow_backorder ? Number.MAX_SAFE_INTEGER : row.on_hand - row.reserved,
      allowBackorder: row.allow_backorder,
    };
  }

  /** Set on-hand stock (receiving, cycle count). Refuses to go below what is already reserved. */
  async setOnHand(
    db: DbOrTx,
    variantId: string,
    onHand: number,
    opts: { allowBackorder?: boolean } = {},
  ): Promise<void> {
    if (!Number.isInteger(onHand) || onHand < 0) throw new ValidationError('onHand must be >= 0');
    await db.transaction(async (tx) => {
      const backorder = opts.allowBackorder;
      const res = await tx.execute(sql`
        INSERT INTO inventory_levels (variant_id, on_hand, allow_backorder)
        VALUES (${variantId}, ${onHand}, ${backorder ?? false})
        ON CONFLICT (variant_id) DO UPDATE SET
          on_hand = EXCLUDED.on_hand,
          allow_backorder = COALESCE(${backorder ?? null}::boolean, inventory_levels.allow_backorder)
        WHERE inventory_levels.allow_backorder
           OR COALESCE(${backorder ?? null}::boolean, false)
           OR EXCLUDED.on_hand >= inventory_levels.reserved
        RETURNING variant_id`);
      if (res.rows.length === 0)
        throw new ValidationError('Cannot set on-hand below the quantity already reserved');
    });
    await this.gate?.invalidate([variantId]);
  }

  /** Hold every line for `ownerRef`, all-or-nothing, locking variants in a fixed order (no deadlocks). */
  async reserveMany(
    db: DbOrTx,
    ownerRef: string,
    lines: { variantId: string; quantity: number }[],
    ttlSeconds: number = this.ttl,
  ): Promise<ReserveResult[]> {
    const sorted = [...lines].sort((a, b) => a.variantId.localeCompare(b.variantId));
    return db.transaction(async (tx) => {
      const results: ReserveResult[] = [];
      for (const line of sorted)
        results.push(
          await this.strategy.reserve(tx, {
            ownerRef,
            variantId: line.variantId,
            quantity: line.quantity,
            ttlSeconds,
          }),
        );
      return results;
    });
  }

  reserve(
    db: DbOrTx,
    ownerRef: string,
    variantId: string,
    quantity: number,
    ttlSeconds: number = this.ttl,
  ): Promise<ReserveResult> {
    return this.strategy.reserve(db, { ownerRef, variantId, quantity, ttlSeconds });
  }

  release(db: DbOrTx, ownerRef: string, variantId?: string): Promise<StockChange[]> {
    return this.strategy.release(db, ownerRef, variantId);
  }

  /** Sweep expired holds in bounded batches until none are due (or `maxBatches` is reached). */
  async sweepExpired(
    db: DbOrTx,
    now: Date = new Date(),
    opts: { batch?: number; maxBatches?: number } = {},
  ): Promise<number> {
    const batch = opts.batch ?? 500;
    let total = 0;
    for (let i = 0; i < (opts.maxBatches ?? 20); i++) {
      const changes = await this.strategy.expire(db, now, batch);
      total += changes.length;
      if (changes.length < batch) break;
    }
    return total;
  }
}
