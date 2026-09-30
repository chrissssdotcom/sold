import { Money } from '@sold/core';
import type { PricingLine } from '../contracts';
import { normalizeCouponCode, type PromotionDef, type PromotionScope } from './promotion';

/**
 * The pricing + promotions engine. Pure and deterministic: no I/O, no clock (the caller passes `now`), no
 * randomness, no dependence on the order of `promotions` or `couponCodes`.
 *
 * ## Arithmetic
 * All amounts are bigint minor units (`Money`). There are no floats. Rounding decisions:
 *  - Percentages are integer basis points; a percent discount is computed ONCE per application on the eligible
 *    RUNNING net (net after all earlier promotions), rounded HALF-UP (`'half-up'`) to a whole minor unit.
 *  - A discount to be spread over several lines (order-level percent/fixed, scoped percent/fixed) is split with
 *    `Money.allocate`, weighted by each eligible line's running net (largest-remainder), so per-line amounts sum
 *    EXACTLY to the discount and no line receives more than its own running net.
 *  - buy_x_get_y works per line on unit counts (never expands units, so huge quantities are fine). A free unit is
 *    worth its LIST unit price; a percent reward is `freeUnits * unitPrice * bps` rounded half-up once per line.
 *    Every line discount is capped at the line's running net.
 *
 * ## Which promotions are considered
 *  1. Automatic promotions (`code === null`) are always candidates. Coupon promotions are candidates only when a
 *     matching code was supplied (case-insensitive, trimmed; duplicates in `couponCodes` collapse).
 *  2. A candidate must be within its window (`startsAt <= now < endsAt`), have all its Money in the cart currency
 *     and meet `minSubtotal` against the cart LIST subtotal (before any discount). Ineligible automatic promotions
 *     are skipped silently; a coupon that ends up not applied is reported in `rejectedCoupons`.
 *
 * ## Order of evaluation and stacking (exact rules)
 *  - Candidates are sorted by `priority` ascending, then `id` (code-unit order), then `name`. Promotions with a
 *    duplicate `id` collapse to the first in that order. Equal priority therefore never depends on input order.
 *  - Promotions are applied one at a time in that order, each on the running nets left by the previous ones.
 *  - A promotion is "applied" only if it produces a discount > 0 (or grants free shipping). One that matches no
 *    lines / yields nothing is skipped (coupon reason `not_applicable`) and blocks nothing.
 *  - NON-STACKABLE RULE: a non-stackable promotion may only be applied when NOTHING has been applied before it, and
 *    once applied it blocks EVERY later promotion. So priority decides conflicts: the lower priority number wins.
 *    Blocked coupons are reported as `not_stackable`. (To make a non-stackable coupon beat automatic promotions,
 *    give it a lower priority number.)
 *  - EXCLUSIVE GROUP RULE: when the first member of an `exclusiveGroup` is reached, ALL not-yet-processed eligible
 *    members of that group are evaluated against the current running nets. The member with the largest discount
 *    amount wins (ties: the earlier in evaluation order); it is applied at this position and the other members are
 *    dropped (coupon reason `exclusive_group`). Members blocked by the non-stackable rule are not candidates.
 *    A free_shipping promotion counts as a zero-amount discount when compared.
 *  - Order-level discounts can never exceed the order total and no line can go below zero, by construction.
 */

export interface PricingInput {
  /** ISO-4217 cart currency. Every line price must be in it. */
  currency: string;
  lines: readonly PricingLine[];
  promotions: readonly PromotionDef[];
  /** Coupon codes the customer entered. */
  couponCodes: readonly string[];
  now: Date;
}

export interface PricedLine {
  lineId: string;
  quantity: number;
  unitPrice: Money;
  /** `unitPrice * quantity`. */
  listTotal: Money;
  /** Total of all promotion discounts allocated to this line. */
  discount: Money;
  /** `listTotal - discount`, never negative. */
  net: Money;
}

export interface AppliedDiscount {
  promotionId: string;
  name: string;
  /** The promotion's coupon code as defined, or `null` for an automatic promotion. */
  code: string | null;
  kind: PromotionDef['kind'];
  /** Total taken off the cart. Always equals the sum of `perLine`. Zero for a pure free-shipping promotion. */
  amount: Money;
  /** Non-zero per-line amounts, in cart line order. */
  perLine: { lineId: string; amount: Money }[];
  /** True for a `free_shipping` promotion. */
  grantsFreeShipping: boolean;
  /** Limits checkout must enforce/record for this redemption (the engine does not enforce them). */
  usage: { usageLimit: number | null; perCustomerLimit: number | null };
}

export type CouponRejectionReason =
  | 'unknown'
  | 'not_started'
  | 'expired'
  | 'min_subtotal'
  | 'not_stackable'
  | 'currency_mismatch'
  | 'not_applicable'
  | 'exclusive_group';

export interface RejectedCoupon {
  /** The code as the customer supplied it (trimmed). */
  code: string;
  reason: CouponRejectionReason;
}

export interface PricedCart {
  currency: string;
  lines: PricedLine[];
  discounts: AppliedDiscount[];
  /** Sum of line list totals. */
  subtotal: Money;
  /** Sum of all applied discounts. */
  discountTotal: Money;
  /** `subtotal - discountTotal`, never negative. */
  net: Money;
  freeShipping: boolean;
  rejectedCoupons: RejectedCoupon[];
}

/** Malformed pricing input (a caller bug, not a business outcome). Business outcomes are reported in the result. */
export class PricingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingInputError';
  }
}

interface Evaluation {
  /** Per line index, parallel to `lines`. */
  perLine: bigint[];
  total: bigint;
  freeShipping: boolean;
}

type Disposition = 'applied' | CouponRejectionReason;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePromotions(a: PromotionDef, b: PromotionDef): number {
  return a.priority - b.priority || compareText(a.id, b.id) || compareText(a.name, b.name);
}

function inScope(scope: PromotionScope, line: PricingLine): boolean {
  switch (scope.type) {
    case 'order':
      return true;
    case 'products':
      return scope.productIds.includes(line.productId);
    case 'tags':
      return line.tags.some((tag) => scope.tags.includes(tag));
  }
}

function promotionMoney(promo: PromotionDef): Money[] {
  const money: Money[] = [];
  if (promo.minSubtotal) money.push(promo.minSubtotal);
  if (promo.kind === 'fixed_off') money.push(promo.amount);
  return money;
}

/** Split `total` over `indices` weighted by their running net; returns a per-line-index array. */
function spread(total: bigint, indices: number[], nets: bigint[], currency: string): bigint[] {
  const out = nets.map(() => 0n);
  if (total <= 0n || indices.length === 0) return out;
  const parts = Money.of(total, currency).allocate(indices.map((i) => nets[i] ?? 0n));
  indices.forEach((lineIndex, position) => {
    out[lineIndex] = parts[position]?.amount ?? 0n;
  });
  return out;
}

/** Free (rewarded) positions among the first `x` units of a sorted pool, groups of buy+get, full groups only. */
function rewardedBefore(x: bigint, buy: bigint, get: bigint, fullEnd: bigint): bigint {
  const clamped = x < fullEnd ? x : fullEnd;
  const group = buy + get;
  const remainder = clamped % group;
  return (clamped / group) * get + (remainder > buy ? remainder - buy : 0n);
}

function evaluate(
  promo: PromotionDef,
  lines: readonly PricingLine[],
  nets: bigint[],
  currency: string,
): Evaluation | null {
  const perLine = nets.map(() => 0n);
  switch (promo.kind) {
    case 'free_shipping':
      return lines.length === 0 ? null : { perLine, total: 0n, freeShipping: true };
    case 'percent_off':
    case 'fixed_off': {
      const eligible: number[] = [];
      let eligibleNet = 0n;
      lines.forEach((line, i) => {
        if (inScope(promo.scope, line) && (nets[i] ?? 0n) > 0n) {
          eligible.push(i);
          eligibleNet += nets[i] ?? 0n;
        }
      });
      const wanted =
        promo.kind === 'percent_off'
          ? Money.of(eligibleNet, currency).basisPoints(promo.basisPoints, 'half-up').amount
          : promo.amount.amount;
      const total = wanted < eligibleNet ? wanted : eligibleNet;
      if (total <= 0n) return null;
      return { perLine: spread(total, eligible, nets, currency), total, freeShipping: false };
    }
    case 'buy_x_get_y': {
      const buy = BigInt(promo.buyQuantity);
      const get = BigInt(promo.getQuantity);
      const pool = lines
        .map((line, i) => ({
          i,
          lineId: line.lineId,
          price: line.unitPrice.amount,
          qty: BigInt(line.quantity),
        }))
        .filter((entry) => inScope(promo.scope, lines[entry.i] as PricingLine) && entry.price > 0n);
      const rewardedUnits = new Map<number, bigint>();
      if (promo.mode === 'same') {
        for (const entry of pool) {
          const fullEnd = (entry.qty / (buy + get)) * (buy + get);
          rewardedUnits.set(entry.i, rewardedBefore(entry.qty, buy, get, fullEnd));
        }
      } else {
        pool.sort((a, b) =>
          a.price === b.price ? compareText(a.lineId, b.lineId) : a.price > b.price ? -1 : 1,
        );
        const totalUnits = pool.reduce((sum, entry) => sum + entry.qty, 0n);
        const fullEnd = (totalUnits / (buy + get)) * (buy + get);
        let start = 0n;
        for (const entry of pool) {
          const end = start + entry.qty;
          rewardedUnits.set(
            entry.i,
            rewardedBefore(end, buy, get, fullEnd) - rewardedBefore(start, buy, get, fullEnd),
          );
          start = end;
        }
      }
      let total = 0n;
      for (const entry of pool) {
        const units = rewardedUnits.get(entry.i) ?? 0n;
        if (units <= 0n) continue;
        const gross = Money.of(units * entry.price, currency);
        const wanted =
          promo.reward.type === 'free'
            ? gross.amount
            : gross.basisPoints(promo.reward.basisPoints, 'half-up').amount;
        const available = nets[entry.i] ?? 0n;
        const amount = wanted < available ? wanted : available;
        perLine[entry.i] = amount;
        total += amount;
      }
      return total > 0n ? { perLine, total, freeShipping: false } : null;
    }
  }
}

function validate(input: PricingInput): void {
  Money.zero(input.currency); // throws RangeError on an unknown currency code
  const seen = new Set<string>();
  for (const line of input.lines) {
    if (seen.has(line.lineId)) throw new PricingInputError(`Duplicate lineId "${line.lineId}"`);
    seen.add(line.lineId);
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1)
      throw new PricingInputError(
        `Line "${line.lineId}": quantity must be a positive safe integer`,
      );
    if (line.unitPrice.currency !== input.currency)
      throw new PricingInputError(
        `Line "${line.lineId}": price is ${line.unitPrice.currency}, cart is ${input.currency}`,
      );
    if (line.unitPrice.isNegative())
      throw new PricingInputError(`Line "${line.lineId}": unit price must not be negative`);
  }
}

export function computePricing(input: PricingInput): PricedCart {
  validate(input);
  const { currency, lines, now } = input;
  const money = (amount: bigint): Money => Money.of(amount, currency);

  const listTotals = lines.map((line) => line.unitPrice.amount * BigInt(line.quantity));
  const subtotal = listTotals.reduce((sum, total) => sum + total, 0n);
  const nets = [...listTotals];

  // Deterministic evaluation order; duplicate ids collapse to the first.
  const sorted = [...input.promotions].sort(comparePromotions);
  const ids = new Set<string>();
  const promotions = sorted.filter((promo) =>
    ids.has(promo.id) ? false : (ids.add(promo.id), true),
  );

  const supplied = new Map<string, string>(); // normalised -> as supplied (first wins)
  for (const raw of input.couponCodes) {
    const key = normalizeCouponCode(raw);
    if (!supplied.has(key)) supplied.set(key, raw.trim());
  }

  // Phase 1: eligibility (window, currency, min subtotal). Disposition is kept per promotion for coupon reporting.
  const dispositions = new Map<string, Disposition>();
  const eligible: PromotionDef[] = [];
  for (const promo of promotions) {
    const viaCoupon = promo.code !== null;
    if (viaCoupon && !supplied.has(normalizeCouponCode(promo.code as string))) continue;
    let reason: CouponRejectionReason | null = null;
    if (promotionMoney(promo).some((m) => m.currency !== currency)) reason = 'currency_mismatch';
    else if (promo.startsAt && now.getTime() < promo.startsAt.getTime()) reason = 'not_started';
    else if (promo.endsAt && now.getTime() >= promo.endsAt.getTime()) reason = 'expired';
    else if (promo.minSubtotal && subtotal < promo.minSubtotal.amount) reason = 'min_subtotal';
    if (reason) dispositions.set(promo.id, reason);
    else eligible.push(promo);
  }

  // Phase 2: sequential application.
  const discounts: AppliedDiscount[] = [];
  const processed = new Set<string>();
  let anyApplied = false;
  let locked = false; // a non-stackable promotion has been applied

  const blocked = (promo: PromotionDef): boolean => locked || (!promo.stackable && anyApplied);

  const apply = (promo: PromotionDef, evaluation: Evaluation): void => {
    const perLine: AppliedDiscount['perLine'] = [];
    evaluation.perLine.forEach((amount, i) => {
      if (amount <= 0n) return;
      nets[i] = (nets[i] ?? 0n) - amount;
      perLine.push({ lineId: lines[i]?.lineId ?? '', amount: money(amount) });
    });
    discounts.push({
      promotionId: promo.id,
      name: promo.name,
      code: promo.code,
      kind: promo.kind,
      amount: money(evaluation.total),
      perLine,
      grantsFreeShipping: evaluation.freeShipping,
      usage: { usageLimit: promo.usageLimit, perCustomerLimit: promo.perCustomerLimit },
    });
    dispositions.set(promo.id, 'applied');
    anyApplied = true;
    if (!promo.stackable) locked = true;
  };

  for (const promo of eligible) {
    if (processed.has(promo.id)) continue;
    const group = promo.exclusiveGroup;
    const members =
      group === undefined
        ? [promo]
        : eligible.filter((other) => other.exclusiveGroup === group && !processed.has(other.id));
    for (const member of members) processed.add(member.id);

    let best: { promo: PromotionDef; evaluation: Evaluation } | null = null;
    for (const member of members) {
      if (blocked(member)) {
        dispositions.set(member.id, 'not_stackable');
        continue;
      }
      const evaluation = evaluate(member, lines, nets, currency);
      if (!evaluation) {
        dispositions.set(member.id, 'not_applicable');
        continue;
      }
      if (best === null) best = { promo: member, evaluation };
      else if (evaluation.total > best.evaluation.total) {
        dispositions.set(best.promo.id, 'exclusive_group');
        best = { promo: member, evaluation };
      } else dispositions.set(member.id, 'exclusive_group');
    }
    if (best) apply(best.promo, best.evaluation);
  }

  // Coupon report: a code is accepted if any promotion it activates was applied.
  const rejectedCoupons: RejectedCoupon[] = [];
  for (const [key, shown] of supplied) {
    const matching = promotions.filter(
      (promo) => promo.code !== null && normalizeCouponCode(promo.code) === key,
    );
    if (matching.length === 0) {
      rejectedCoupons.push({ code: shown, reason: 'unknown' });
      continue;
    }
    if (matching.some((promo) => dispositions.get(promo.id) === 'applied')) continue;
    const first = dispositions.get((matching[0] as PromotionDef).id);
    rejectedCoupons.push({
      code: shown,
      reason: first === undefined || first === 'applied' ? 'not_applicable' : first,
    });
  }
  rejectedCoupons.sort((a, b) => compareText(a.code, b.code));

  const pricedLines: PricedLine[] = lines.map((line, i) => {
    const listTotal = listTotals[i] ?? 0n;
    const net = nets[i] ?? 0n;
    return {
      lineId: line.lineId,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      listTotal: money(listTotal),
      discount: money(listTotal - net),
      net: money(net),
    };
  });
  const net = nets.reduce((sum, value) => sum + value, 0n);

  return {
    currency,
    lines: pricedLines,
    discounts,
    subtotal: money(subtotal),
    discountTotal: money(subtotal - net),
    net: money(net),
    freeShipping: discounts.some((discount) => discount.grantsFreeShipping),
    rejectedCoupons,
  };
}
