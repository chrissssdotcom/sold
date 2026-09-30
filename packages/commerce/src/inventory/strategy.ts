import type { DbOrTx, Tx } from '../types';

export interface ReserveRequest {
  /** The cart or checkout holding the stock. (owner, variant) is the idempotency key. */
  ownerRef: string;
  variantId: string;
  quantity: number;
  ttlSeconds: number;
}

/** Stock returned to (or taken from) availability for one variant. */
export interface StockChange {
  variantId: string;
  quantity: number;
}

export interface ReserveResult {
  reservationId: string;
  /** False when an identical live hold already existed (a retried request). */
  created: boolean;
  quantity: number;
  expiresAt: Date;
}

/**
 * How stock is held. The default is `PostgresReservationStrategy`, which is authoritative and always
 * correct. `GatedReservationStrategy` wraps another strategy with a Redis admission gate for hot SKUs.
 * Alternative strategies (bucketed counters, external WMS) implement this same interface.
 */
export interface InventoryReservationStrategy {
  readonly name: string;
  /** Throws `InsufficientStockError` when the hold cannot be made. Never oversells. */
  reserve(db: DbOrTx, req: ReserveRequest): Promise<ReserveResult>;
  /** Release live holds for an owner (all variants, or one). Returns the stock that came back. */
  release(db: DbOrTx, ownerRef: string, variantId?: string): Promise<StockChange[]>;
  /** Convert live holds into a permanent decrement (on order placement). Must run in the order's tx. */
  commit(tx: Tx, ownerRef: string): Promise<StockChange[]>;
  /** Expire holds past their TTL, returning the stock. Batch-bounded so it never holds long locks. */
  expire(db: DbOrTx, now: Date, limit: number): Promise<StockChange[]>;
}
