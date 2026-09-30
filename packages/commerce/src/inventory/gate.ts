import { CircuitBreaker, withTimeout } from '@sold/core/resilience';
import { InsufficientStockError } from '../errors';
import type { DbOrTx, Tx } from '../types';
import type {
  InventoryReservationStrategy,
  ReserveRequest,
  ReserveResult,
  StockChange,
} from './strategy';

/** The subset of ioredis this module needs, so tests can substitute a fake and no client is imported here. */
export interface RedisEval {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
}

// -1 = no counter (unknown): caller seeds from Postgres. 0 = sold out. 1 = token taken.
const TAKE = `
local v = redis.call('GET', KEYS[1])
if not v then return -1 end
local q = tonumber(ARGV[1])
if tonumber(v) < q then return 0 end
redis.call('DECRBY', KEYS[1], q)
return 1`;

// Only give back to a counter that still exists; a missing counter is reseeded from Postgres anyway.
const GIVE = `
if redis.call('EXISTS', KEYS[1]) == 1 then redis.call('INCRBY', KEYS[1], ARGV[1]) end
return 1`;

const SEED = `return redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2], 'NX') and 1 or 0`;

export interface GateOptions {
  redis: RedisEval;
  /** Reads current availability from the authoritative store, used to (re)seed a counter. */
  availability: (variantId: string) => Promise<number>;
  /** Seconds a counter lives before it is re-derived from Postgres. Bounds any drift. Default 30. */
  counterTtlSeconds?: number;
  redisTimeoutMs?: number;
  keyPrefix?: string;
  onEvent?: (event: 'rejected' | 'passed' | 'seeded' | 'redis_error') => void;
}

/**
 * Admission gate for hot SKUs (Section 8A.5). During a drop, thousands of buyers chase a few units; sending
 * every one of them to a single Postgres row lock wastes the connection pool on requests that can only
 * fail. A Redis counter answers "sold out" in microseconds and lets through about as many requests as there
 * are units.
 *
 * It is an optimisation, never the source of truth:
 *  - The counter may be stale-high (a crash before we give a token back): harmless, Postgres refuses.
 *  - It may be stale-low (a release whose give-back was lost): shoppers see "sold out" early, for at most
 *    `counterTtlSeconds`, then the counter is re-derived from Postgres.
 *  - Redis down or slow: fail open (straight to Postgres) behind a circuit breaker.
 * So it can reject wrongly for a short while, but it can never cause an oversell.
 */
export class InventoryGate {
  private readonly breaker = new CircuitBreaker({ name: 'inventory-gate', failureThreshold: 3 });
  private readonly ttl: number;
  private readonly timeout: number;
  private readonly prefix: string;

  constructor(private readonly opts: GateOptions) {
    this.ttl = opts.counterTtlSeconds ?? 30;
    this.timeout = opts.redisTimeoutMs ?? 50;
    this.prefix = opts.keyPrefix ?? 'inv:gate:';
  }

  private key(variantId: string): string {
    return `${this.prefix}${variantId}`;
  }

  private async redis<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await this.breaker.exec(() => withTimeout(fn(), this.timeout, 'inventory-gate'));
    } catch {
      this.opts.onEvent?.('redis_error');
      return undefined; // fail open
    }
  }

  /** `taken`: a token was taken (give it back if the real reservation fails). `open`: gate not consulted. */
  async admit(variantId: string, quantity: number): Promise<'taken' | 'sold_out' | 'open'> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await this.redis(
        () => this.opts.redis.eval(TAKE, 1, this.key(variantId), quantity) as Promise<number>,
      );
      if (r === undefined) return 'open';
      if (r === 1) return 'taken';
      if (r === 0) return 'sold_out';
      // Unknown counter: seed from the authoritative store, then take.
      const available = await this.opts.availability(variantId);
      await this.redis(() =>
        this.opts.redis.eval(SEED, 1, this.key(variantId), Math.max(available, 0), this.ttl),
      );
      this.opts.onEvent?.('seeded');
    }
    return 'open';
  }

  async giveBack(variantId: string, quantity: number): Promise<void> {
    if (quantity <= 0) return;
    await this.redis(() => this.opts.redis.eval(GIVE, 1, this.key(variantId), quantity));
  }

  /** Forget counters (stock adjusted by an admin, restock, backorder toggle): re-derived on next use. */
  async invalidate(variantIds: string[]): Promise<void> {
    if (variantIds.length === 0) return;
    await this.redis(() => this.opts.redis.del(...variantIds.map((v) => this.key(v))));
  }
}

/** Wraps a strategy with the admission gate. */
export class GatedReservationStrategy implements InventoryReservationStrategy {
  readonly name: string;

  constructor(
    private readonly inner: InventoryReservationStrategy,
    private readonly gate: InventoryGate,
    private readonly onEvent?: GateOptions['onEvent'],
  ) {
    this.name = `gated(${inner.name})`;
  }

  async reserve(db: DbOrTx, req: ReserveRequest): Promise<ReserveResult> {
    const verdict = await this.gate.admit(req.variantId, req.quantity);
    if (verdict === 'sold_out') {
      this.onEvent?.('rejected');
      throw new InsufficientStockError(req.variantId, req.quantity, 0);
    }
    this.onEvent?.('passed');
    try {
      const result = await this.inner.reserve(db, req);
      // A retry of an existing hold takes no new stock: return the token we just took.
      if (!result.created && verdict === 'taken')
        await this.gate.giveBack(req.variantId, req.quantity);
      return result;
    } catch (error) {
      if (verdict === 'taken') await this.gate.giveBack(req.variantId, req.quantity);
      throw error;
    }
  }

  async release(db: DbOrTx, ownerRef: string, variantId?: string): Promise<StockChange[]> {
    const changes = await this.inner.release(db, ownerRef, variantId);
    await this.returned(changes);
    return changes;
  }

  commit(tx: Tx, ownerRef: string): Promise<StockChange[]> {
    // Availability is unchanged by a commit (reserved -> sold), so the counter needs no update.
    return this.inner.commit(tx, ownerRef);
  }

  async expire(db: DbOrTx, now: Date, limit: number): Promise<StockChange[]> {
    const changes = await this.inner.expire(db, now, limit);
    await this.returned(changes);
    return changes;
  }

  private async returned(changes: StockChange[]): Promise<void> {
    await Promise.all(changes.map((c) => this.gate.giveBack(c.variantId, c.quantity)));
  }
}
