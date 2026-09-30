import { Money, type Rational, type RoundingMode } from '@sold/core';
import type { DbOrTx } from '@sold/commerce';
import { and, desc, eq, lte, schema, sql } from '@sold/db';
import type { FxProvider, FxQuote } from './provider';
import { parseRoundingRule } from './rounding';

export class FxRateUnavailableError extends Error {
  constructor(
    readonly base: string,
    readonly quote: string,
    readonly reason: 'missing' | 'stale',
  ) {
    super(`No ${reason === 'stale' ? 'fresh ' : ''}FX rate for ${base}->${quote}`);
    this.name = 'FxRateUnavailableError';
  }
}

export interface StoredRate {
  base: string;
  quote: string;
  rate: Rational;
  source: string;
  fetchedAt: Date;
}

export interface FxServiceOptions {
  /** A refreshed rate that differs from the previous one by more than this many basis points is rejected as a bad feed. */
  maxMoveBps?: number;
  /** Rates older than this are "stale": conversion refuses rather than use a rate that may be wrong. */
  maxAgeHours?: number;
  now?: () => Date;
}

export interface RefreshResult {
  accepted: FxQuote[];
  rejected: { quote: string; reason: string }[];
}

const { fxRates, variantPrices } = schema;

/**
 * Exchange rates: append-only history, guarded ingestion, exact rational conversion. Prices in other currencies are
 * MATERIALISED into `variant_prices` when rates refresh, so the storefront never converts (or calls a feed) on a
 * request path: it reads static rows that a CDN can cache.
 */
export class FxService {
  private readonly maxMoveBps: bigint;
  private readonly maxAgeMs: number;
  private readonly now: () => Date;

  constructor(opts: FxServiceOptions = {}) {
    this.maxMoveBps = BigInt(opts.maxMoveBps ?? 2_000); // 20%
    this.maxAgeMs = (opts.maxAgeHours ?? 48) * 3_600_000;
    this.now = opts.now ?? (() => new Date());
  }

  /** Fetch, sanity-check against the previous rate, and append. A rejected rate keeps the previous one in force. */
  async refresh(
    db: DbOrTx,
    provider: FxProvider,
    base: string,
    quotes: readonly string[],
  ): Promise<RefreshResult> {
    const fetched = await provider.fetchRates(base, quotes);
    const accepted: FxQuote[] = [];
    const rejected: RefreshResult['rejected'] = [];
    for (const q of quotes)
      if (!fetched.some((f) => f.quote === q))
        rejected.push({ quote: q, reason: 'not returned by provider' });
    for (const f of fetched) {
      if (f.rate.numerator <= 0n || f.rate.denominator <= 0n) {
        rejected.push({ quote: f.quote, reason: 'non-positive rate' });
        continue;
      }
      const prev = await this.latest(db, base, f.quote, { allowStale: true });
      if (prev && this.movedTooFar(prev.rate, f.rate)) {
        rejected.push({
          quote: f.quote,
          reason: `moved more than ${this.maxMoveBps / 100n}% since the last rate`,
        });
        continue;
      }
      await db.insert(fxRates).values({
        base,
        quote: f.quote,
        rateNum: f.rate.numerator,
        rateDen: f.rate.denominator,
        source: provider.name,
        fetchedAt: this.now(),
      });
      accepted.push(f);
    }
    return { accepted, rejected };
  }

  private movedTooFar(prev: Rational, next: Rational): boolean {
    // |next/prev - 1| > maxMoveBps/10000  <=>  |next*pd - prev*nd| * 10000 > maxMoveBps * prev*nd
    const nd = next.denominator * prev.numerator; // prev.num * next.den
    const diff = next.numerator * prev.denominator - nd;
    const abs = diff < 0n ? -diff : diff;
    return abs * 10_000n > this.maxMoveBps * nd;
  }

  async latest(
    db: DbOrTx,
    base: string,
    quote: string,
    opts: { allowStale?: boolean; at?: Date } = {},
  ): Promise<StoredRate | null> {
    const [row] = await db
      .select()
      .from(fxRates)
      .where(
        and(
          eq(fxRates.base, base),
          eq(fxRates.quote, quote),
          opts.at ? lte(fxRates.fetchedAt, opts.at) : sql`true`,
        ),
      )
      .orderBy(desc(fxRates.fetchedAt))
      .limit(1);
    if (!row) return null;
    const rate: StoredRate = {
      base,
      quote,
      rate: { numerator: row.rateNum, denominator: row.rateDen },
      source: row.source,
      fetchedAt: row.fetchedAt,
    };
    if (
      !opts.allowStale &&
      !opts.at &&
      this.now().getTime() - row.fetchedAt.getTime() > this.maxAgeMs
    )
      return null;
    return rate;
  }

  /** Exact conversion with the latest fresh rate (or the rate in force `at` a past instant, for reporting). */
  async convert(
    db: DbOrTx,
    amount: Money,
    target: string,
    mode: RoundingMode,
    opts: { at?: Date } = {},
  ): Promise<{ money: Money; rate: StoredRate }> {
    if (amount.currency === target) throw new RangeError('Already in the target currency');
    const rate = await this.latest(db, amount.currency, target, opts.at ? { at: opts.at } : {});
    if (!rate) {
      const stale = await this.latest(db, amount.currency, target, { allowStale: true });
      throw new FxRateUnavailableError(amount.currency, target, stale ? 'stale' : 'missing');
    }
    return { money: amount.convert(rate.rate, target, mode), rate };
  }

  /**
   * Recompute derived prices for `target` currencies from base-currency prices and the latest rates. Only rows with
   * `source = 'derived'` (or absent) are written, so hand-set prices are never touched, and unchanged rows are not
   * rewritten. Works in keyset batches: bounded memory and short transactions at any catalogue size.
   */
  async deriveAll(
    db: DbOrTx,
    opts: { base: string; targets: { code: string; rounding?: string }[]; batchSize?: number },
  ): Promise<{ written: number; unchanged: number; skippedNoRate: string[] }> {
    const batch = opts.batchSize ?? 1_000;
    let written = 0;
    let unchanged = 0;
    const skippedNoRate: string[] = [];
    for (const target of opts.targets) {
      const rate = await this.latest(db, opts.base, target.code);
      if (!rate) {
        skippedNoRate.push(target.code);
        continue;
      }
      const round = parseRoundingRule(target.rounding, target.code);
      let after = '00000000-0000-0000-0000-000000000000';
      for (;;) {
        const rows = await db
          .select({
            variantId: variantPrices.variantId,
            amount: variantPrices.amount,
            compareAt: variantPrices.compareAt,
          })
          .from(variantPrices)
          .where(
            and(eq(variantPrices.currency, opts.base), sql`${variantPrices.variantId} > ${after}`),
          )
          .orderBy(variantPrices.variantId)
          .limit(batch);
        if (rows.length === 0) break;
        after = rows[rows.length - 1]!.variantId;
        const values = rows.map((r) => {
          const convert = (minor: bigint) =>
            round(Money.of(minor, opts.base).convert(rate.rate, target.code, 'half-up').amount);
          return {
            variantId: r.variantId,
            currency: target.code,
            amount: convert(r.amount),
            compareAt: r.compareAt === null ? null : convert(r.compareAt),
            source: 'derived' as const,
          };
        });
        const res = await db
          .insert(variantPrices)
          .values(values)
          .onConflictDoUpdate({
            target: [variantPrices.variantId, variantPrices.currency],
            set: {
              amount: sql`excluded.amount`,
              compareAt: sql`excluded.compare_at`,
              updatedAt: sql`now()`,
            },
            // Never overwrite a manual price; skip rows whose derived value did not change.
            setWhere: sql`${variantPrices.source} = 'derived' AND (${variantPrices.amount} IS DISTINCT FROM excluded.amount OR ${variantPrices.compareAt} IS DISTINCT FROM excluded.compare_at)`,
          })
          .returning({ variantId: variantPrices.variantId });
        written += res.length;
        unchanged += values.length - res.length;
      }
    }
    return { written, unchanged, skippedNoRate };
  }
}
