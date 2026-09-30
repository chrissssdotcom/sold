import { Money } from '@sold/core';
import { describe, expect, it } from 'vitest';
import type { PricingLine } from '../contracts';
import {
  computePricing,
  defaultPricingProvider,
  parsePromotion,
  PricingInputError,
  promotionSchema,
  type CouponRejectionReason,
  type PricedCart,
  type PricingInput,
  type PromotionDef,
  type PromotionInput,
} from './index';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const DAY = 86_400_000;
const past = (days: number): Date => new Date(NOW.getTime() - days * DAY);
const future = (days: number): Date => new Date(NOW.getTime() + days * DAY);

function line(
  lineId: string,
  price: bigint,
  quantity: number,
  extra: { productId?: string; tags?: string[]; currency?: string } = {},
): PricingLine {
  return {
    lineId,
    variantId: `v-${lineId}`,
    sku: `sku-${lineId}`,
    title: `Item ${lineId}`,
    quantity,
    unitPrice: Money.of(price, extra.currency ?? 'AUD'),
    weightGrams: 100,
    productId: extra.productId ?? `prod-${lineId}`,
    tags: extra.tags ?? [],
  };
}

function promo(input: PromotionInput): PromotionDef {
  return parsePromotion(input);
}

const pct = (id: string, basisPoints: number, extra: Partial<PromotionInput> = {}): PromotionDef =>
  promo({ id, name: id, kind: 'percent_off', basisPoints, ...extra } as PromotionInput);

const fixed = (id: string, amount: bigint, extra: Partial<PromotionInput> = {}): PromotionDef =>
  promo({
    id,
    name: id,
    kind: 'fixed_off',
    amount: Money.of(amount, 'AUD'),
    ...extra,
  } as PromotionInput);

const freeShip = (id: string, extra: Partial<PromotionInput> = {}): PromotionDef =>
  promo({ id, name: id, kind: 'free_shipping', ...extra } as PromotionInput);

function bxgy(
  id: string,
  buyQuantity: number,
  getQuantity: number,
  extra: Partial<PromotionInput> = {},
): PromotionDef {
  return promo({
    id,
    name: id,
    kind: 'buy_x_get_y',
    scope: { type: 'order' },
    buyQuantity,
    getQuantity,
    reward: { type: 'free' },
    mode: 'cheapest',
    ...extra,
  } as PromotionInput);
}

function price(
  lines: PricingLine[],
  promotions: PromotionDef[] = [],
  couponCodes: string[] = [],
  currency = 'AUD',
  now = NOW,
): PricedCart {
  return computePricing({ currency, lines, promotions, couponCodes, now });
}

const amounts = (cart: PricedCart): Record<string, bigint> =>
  Object.fromEntries(cart.discounts.map((d) => [d.promotionId, d.amount.amount]));
const lineDiscounts = (cart: PricedCart): bigint[] => cart.lines.map((l) => l.discount.amount);
const reasons = (cart: PricedCart): Record<string, CouponRejectionReason> =>
  Object.fromEntries(cart.rejectedCoupons.map((r) => [r.code, r.reason]));

/** The invariants that must hold for EVERY cart. */
function assertInvariants(cart: PricedCart, input: PricingInput): void {
  const zero = Money.zero(input.currency);
  const lineDiscountSum = cart.lines.reduce((sum, l) => sum.add(l.discount), zero);
  expect(lineDiscountSum.equals(cart.discountTotal)).toBe(true);
  expect(
    cart.discounts.reduce((sum, d) => sum.add(d.amount), zero).equals(cart.discountTotal),
  ).toBe(true);
  for (const d of cart.discounts) {
    expect(d.perLine.reduce((sum, p) => sum.add(p.amount), zero).equals(d.amount)).toBe(true);
    expect(d.amount.isNegative()).toBe(false);
  }
  expect(cart.net.amount >= 0n).toBe(true);
  expect(cart.net.equals(cart.subtotal.subtract(cart.discountTotal))).toBe(true);
  expect(cart.subtotal.equals(cart.lines.reduce((sum, l) => sum.add(l.listTotal), zero))).toBe(
    true,
  );
  expect(cart.net.equals(cart.lines.reduce((sum, l) => sum.add(l.net), zero))).toBe(true);
  for (const l of cart.lines) {
    expect(l.net.amount >= 0n).toBe(true);
    expect(l.discount.amount >= 0n).toBe(true);
    expect(l.net.equals(l.listTotal.subtract(l.discount))).toBe(true);
    expect(l.listTotal.equals(l.unitPrice.times(l.quantity))).toBe(true);
  }
  // Per-line breakdown of each discount adds up to the line's total discount.
  for (const l of cart.lines) {
    const fromDiscounts = cart.discounts
      .flatMap((d) => d.perLine)
      .filter((p) => p.lineId === l.lineId)
      .reduce((sum, p) => sum.add(p.amount), zero);
    expect(fromDiscounts.equals(l.discount)).toBe(true);
  }
}

describe('promotion schema', () => {
  it('fills defaults', () => {
    const p = promo({ id: 'a', name: 'A', kind: 'percent_off', basisPoints: 500 });
    expect(p).toMatchObject({
      code: null,
      startsAt: null,
      endsAt: null,
      minSubtotal: null,
      usageLimit: null,
      perCustomerLimit: null,
      stackable: true,
      priority: 100,
      scope: { type: 'order' },
    });
    expect(p.exclusiveGroup).toBeUndefined();
  });

  it('accepts JSON-shaped input: Money JSON, ISO dates, trimmed code', () => {
    const p = parsePromotion({
      id: 'j',
      name: 'JSON',
      kind: 'fixed_off',
      code: '  save5 ',
      amount: { amount: '500', currency: 'AUD' },
      minSubtotal: { amount: 2000n, currency: 'AUD' },
      startsAt: '2026-01-01T00:00:00Z',
      endsAt: '2026-12-31T00:00:00Z',
      scope: { type: 'tags', tags: ['sale'] },
    });
    expect(p.kind === 'fixed_off' && p.amount.equals(Money.of(500n, 'AUD'))).toBe(true);
    expect(p.minSubtotal?.amount).toBe(2000n);
    expect(p.code).toBe('save5');
    expect(p.startsAt).toEqual(new Date('2026-01-01T00:00:00Z'));
  });

  it.each([
    ['bps 0', { id: 'x', name: 'x', kind: 'percent_off', basisPoints: 0 }],
    ['bps above 100%', { id: 'x', name: 'x', kind: 'percent_off', basisPoints: 10_001 }],
    ['fractional bps', { id: 'x', name: 'x', kind: 'percent_off', basisPoints: 12.5 }],
    ['unknown kind', { id: 'x', name: 'x', kind: 'bogus' }],
    ['empty id', { id: '', name: 'x', kind: 'free_shipping' }],
    ['unknown key', { id: 'x', name: 'x', kind: 'free_shipping', surprise: true }],
    ['zero fixed amount', { id: 'x', name: 'x', kind: 'fixed_off', amount: Money.of(0n, 'AUD') }],
    [
      'negative min subtotal',
      { id: 'x', name: 'x', kind: 'free_shipping', minSubtotal: Money.of(-1n, 'AUD') },
    ],
    [
      'unknown currency',
      { id: 'x', name: 'x', kind: 'fixed_off', amount: { amount: '5', currency: 'ZZZ' } },
    ],
    [
      'end before start',
      { id: 'x', name: 'x', kind: 'free_shipping', startsAt: future(2), endsAt: future(1) },
    ],
    ['invalid date', { id: 'x', name: 'x', kind: 'free_shipping', startsAt: new Date('nope') }],
    [
      'empty product scope',
      {
        id: 'x',
        name: 'x',
        kind: 'percent_off',
        basisPoints: 1,
        scope: { type: 'products', productIds: [] },
      },
    ],
    [
      'bxgy zero buy',
      {
        id: 'x',
        name: 'x',
        kind: 'buy_x_get_y',
        scope: { type: 'order' },
        buyQuantity: 0,
        getQuantity: 1,
        reward: { type: 'free' },
      },
    ],
  ])('rejects %s', (_label, input) => {
    expect(promotionSchema.safeParse(input).success).toBe(false);
  });
});

describe('input validation', () => {
  it('rejects malformed carts (caller bugs) with PricingInputError', () => {
    expect(() => price([line('a', 100n, 1), line('a', 100n, 1)])).toThrow(PricingInputError);
    expect(() => price([line('a', 100n, 0)])).toThrow(PricingInputError);
    expect(() => price([line('a', 100n, 1.5)])).toThrow(PricingInputError);
    expect(() => price([line('a', -100n, 1)])).toThrow(PricingInputError);
    expect(() => price([line('a', 100n, 1, { currency: 'USD' })])).toThrow(PricingInputError);
    expect(() => price([], [], [], 'NOPE')).toThrow(/Unsupported currency/);
  });
});

describe('base totals', () => {
  it('prices an empty cart', () => {
    const cart = price([], [pct('p', 1000)]);
    expect(cart.subtotal.amount).toBe(0n);
    expect(cart.net.amount).toBe(0n);
    expect(cart.discounts).toEqual([]);
    expect(cart.freeShipping).toBe(false);
  });

  it('computes list totals without promotions and keeps line order', () => {
    const cart = price([line('b', 1999n, 3), line('a', 500n, 2)]);
    expect(cart.lines.map((l) => l.lineId)).toEqual(['b', 'a']);
    expect(cart.lines[0]?.listTotal.amount).toBe(5997n);
    expect(cart.subtotal.amount).toBe(6997n);
    expect(cart.net.amount).toBe(6997n);
    expect(cart.discountTotal.amount).toBe(0n);
  });
});

describe('percent_off', () => {
  it('rounds half-up once per application on the eligible net, then spreads exactly', () => {
    // 10% of 1005 = 100.5 -> 101 (half-up). Weights 1005 = 335 + 670.
    const cart = price([line('a', 335n, 1), line('b', 335n, 2)], [pct('p', 1000)]);
    expect(cart.discountTotal.amount).toBe(101n);
    expect(lineDiscounts(cart)).toEqual([34n, 67n]);
  });

  it('rounds down below .5', () => {
    const cart = price([line('a', 1004n, 1)], [pct('p', 1000)]); // 100.4
    expect(cart.discountTotal.amount).toBe(100n);
  });

  it('100% takes everything but never more', () => {
    const cart = price([line('a', 999n, 3)], [pct('p', 10_000)]);
    expect(cart.net.amount).toBe(0n);
    assertInvariants(cart, {
      currency: 'AUD',
      lines: [line('a', 999n, 3)],
      promotions: [],
      couponCodes: [],
      now: NOW,
    });
  });

  it('targets products', () => {
    const cart = price(
      [line('a', 1000n, 1, { productId: 'shirt' }), line('b', 1000n, 1, { productId: 'hat' })],
      [pct('p', 5000, { scope: { type: 'products', productIds: ['shirt'] } })],
    );
    expect(lineDiscounts(cart)).toEqual([500n, 0n]);
  });

  it('targets tags (any tag matches)', () => {
    const cart = price(
      [
        line('a', 1000n, 1, { tags: ['sale', 'new'] }),
        line('b', 1000n, 1, { tags: ['new'] }),
        line('c', 1000n, 1),
      ],
      [pct('p', 2000, { scope: { type: 'tags', tags: ['sale', 'clearance'] } })],
    );
    expect(lineDiscounts(cart)).toEqual([200n, 0n, 0n]);
  });

  it('is skipped (silently) when nothing matches its scope', () => {
    const cart = price(
      [line('a', 1000n, 1)],
      [pct('p', 2000, { scope: { type: 'tags', tags: ['nope'] } })],
    );
    expect(cart.discounts).toEqual([]);
  });

  it('applies to the running net: two 50% promotions give 75%', () => {
    const cart = price(
      [line('a', 1000n, 1)],
      [pct('p1', 5000, { priority: 1 }), pct('p2', 5000, { priority: 2 })],
    );
    expect(amounts(cart)).toEqual({ p1: 500n, p2: 250n });
    expect(cart.net.amount).toBe(250n);
  });
});

describe('fixed_off', () => {
  it('spreads an order-level amount by line net with allocate (sums exactly)', () => {
    const cart = price([line('a', 3000n, 1), line('b', 1000n, 1)], [fixed('f', 1000n)]);
    expect(lineDiscounts(cart)).toEqual([750n, 250n]);
  });

  it('distributes odd remainders deterministically (largest remainder, ties by position)', () => {
    const cart = price(
      [line('a', 100n, 1), line('b', 100n, 1), line('c', 100n, 1)],
      [fixed('f', 100n)],
    );
    expect(lineDiscounts(cart)).toEqual([34n, 33n, 33n]);
  });

  it('is capped at the order total', () => {
    const cart = price([line('a', 300n, 1), line('b', 200n, 1)], [fixed('f', 10_000n)]);
    expect(cart.discountTotal.amount).toBe(500n);
    expect(cart.net.amount).toBe(0n);
    expect(lineDiscounts(cart)).toEqual([300n, 200n]);
  });

  it('is capped at the eligible net when scoped, and only touches eligible lines', () => {
    const cart = price(
      [line('a', 400n, 1, { tags: ['t'] }), line('b', 5000n, 1)],
      [fixed('f', 1000n, { scope: { type: 'tags', tags: ['t'] } })],
    );
    expect(lineDiscounts(cart)).toEqual([400n, 0n]);
  });

  it('is taken once, not per unit', () => {
    const cart = price([line('a', 1000n, 5)], [fixed('f', 300n)]);
    expect(cart.discountTotal.amount).toBe(300n);
  });

  it('skips lines whose running net is already zero', () => {
    const cart = price(
      [line('a', 500n, 1, { tags: ['free'] }), line('b', 500n, 1)],
      [
        pct('p1', 10_000, { priority: 1, scope: { type: 'tags', tags: ['free'] } }),
        fixed('f', 200n, { priority: 2 }),
      ],
    );
    expect(lineDiscounts(cart)).toEqual([500n, 200n]);
  });
});

describe('priority and stable ordering', () => {
  it('applies lower priority first, and order changes the result', () => {
    const lines = [line('a', 1000n, 1)];
    const percentFirst = price(lines, [
      pct('p', 1000, { priority: 1 }),
      fixed('f', 500n, { priority: 2 }),
    ]);
    const fixedFirst = price(lines, [
      pct('p', 1000, { priority: 2 }),
      fixed('f', 500n, { priority: 1 }),
    ]);
    expect(percentFirst.discountTotal.amount).toBe(600n); // 100 then 500
    expect(fixedFirst.discountTotal.amount).toBe(550n); // 500 then 10% of 500
    expect(fixedFirst.discounts.map((d) => d.promotionId)).toEqual(['f', 'p']);
  });

  it('breaks priority ties by id, independent of input order', () => {
    const lines = [line('a', 1000n, 1)];
    const a = pct('a', 1000);
    const b = fixed('b', 333n);
    const c = pct('c', 700);
    const orders = [
      [a, b, c],
      [c, b, a],
      [b, a, c],
      [b, c, a],
    ];
    const results = orders.map((promotions) => price(lines, promotions));
    for (const r of results) expect(r).toEqual(results[0]);
    expect(results[0]?.discounts.map((d) => d.promotionId)).toEqual(['a', 'b', 'c']);
  });

  it('collapses duplicate promotion ids to one', () => {
    const cart = price([line('a', 1000n, 1)], [pct('dup', 1000), pct('dup', 1000)]);
    expect(cart.discounts).toHaveLength(1);
  });
});

describe('coupons', () => {
  const lines = [line('a', 5000n, 1)];

  it('applies only when supplied, matching case-insensitively and trimmed', () => {
    const p = fixed('c', 500n, { code: 'Save5' });
    expect(price(lines, [p]).discounts).toEqual([]);
    for (const code of ['SAVE5', 'save5', '  sAvE5 ']) {
      const cart = price(lines, [p], [code]);
      expect(cart.discountTotal.amount).toBe(500n);
      expect(cart.discounts[0]?.code).toBe('Save5');
      expect(cart.rejectedCoupons).toEqual([]);
    }
  });

  it('collapses the same code supplied twice', () => {
    const cart = price(lines, [fixed('c', 500n, { code: 'X' })], ['x', 'X']);
    expect(cart.discounts).toHaveLength(1);
    expect(cart.rejectedCoupons).toEqual([]);
  });

  it('a code that activates several promotions applies all of them', () => {
    const cart = price(
      lines,
      [fixed('c1', 100n, { code: 'BOTH' }), freeShip('c2', { code: 'both' })],
      ['BOTH'],
    );
    expect(cart.discounts.map((d) => d.promotionId)).toEqual(['c1', 'c2']);
    expect(cart.freeShipping).toBe(true);
    expect(cart.rejectedCoupons).toEqual([]);
  });

  it('echoes usage limits without enforcing them', () => {
    const cart = price(
      lines,
      [fixed('c', 500n, { code: 'L', usageLimit: 1, perCustomerLimit: 1 })],
      ['L'],
    );
    expect(cart.discounts[0]?.usage).toEqual({ usageLimit: 1, perCustomerLimit: 1 });
    const auto = price(lines, [pct('auto', 1000)]);
    expect(auto.discounts[0]?.usage).toEqual({ usageLimit: null, perCustomerLimit: null });
    expect(auto.discounts[0]?.code).toBeNull();
  });

  describe('rejections', () => {
    it('unknown', () => {
      const cart = price(lines, [fixed('c', 500n, { code: 'REAL' })], ['NOPE', '']);
      expect(cart.rejectedCoupons).toEqual([
        { code: '', reason: 'unknown' },
        { code: 'NOPE', reason: 'unknown' },
      ]);
    });

    it('not_started', () => {
      const cart = price(
        lines,
        [fixed('c', 500n, { code: 'SOON', startsAt: future(1) })],
        ['soon'],
      );
      expect(cart.rejectedCoupons).toEqual([{ code: 'soon', reason: 'not_started' }]);
      expect(cart.discounts).toEqual([]);
    });

    it('starts exactly at startsAt (inclusive)', () => {
      const cart = price(lines, [fixed('c', 500n, { code: 'NOW', startsAt: NOW })], ['NOW']);
      expect(cart.discountTotal.amount).toBe(500n);
    });

    it('expired, with endsAt exclusive', () => {
      const expired = price(lines, [fixed('c', 500n, { code: 'OLD', endsAt: past(1) })], ['OLD']);
      expect(expired.rejectedCoupons).toEqual([{ code: 'OLD', reason: 'expired' }]);
      const boundary = price(lines, [fixed('c', 500n, { code: 'OLD', endsAt: NOW })], ['OLD']);
      expect(boundary.rejectedCoupons).toEqual([{ code: 'OLD', reason: 'expired' }]);
      const live = price(lines, [fixed('c', 500n, { code: 'OLD', endsAt: future(1) })], ['OLD']);
      expect(live.discountTotal.amount).toBe(500n);
    });

    it('min_subtotal, measured on the LIST subtotal (inclusive)', () => {
      const p = fixed('c', 500n, { code: 'BIG', minSubtotal: Money.of(5001n, 'AUD') });
      expect(price(lines, [p], ['BIG']).rejectedCoupons).toEqual([
        { code: 'BIG', reason: 'min_subtotal' },
      ]);
      const exact = fixed('c', 500n, { code: 'BIG', minSubtotal: Money.of(5000n, 'AUD') });
      expect(price(lines, [exact], ['BIG']).discountTotal.amount).toBe(500n);
      // An earlier discount does not reduce the subtotal the minimum is checked against.
      const both = price(lines, [pct('auto', 5000, { priority: 1 }), exact], ['BIG']);
      expect(amounts(both)).toEqual({ auto: 2500n, c: 500n });
    });

    it('not_stackable when blocked by an earlier non-stackable promotion', () => {
      const cart = price(
        lines,
        [
          pct('solo', 1000, { priority: 1, stackable: false }),
          fixed('c', 500n, { code: 'LATE', priority: 2 }),
        ],
        ['LATE'],
      );
      expect(cart.rejectedCoupons).toEqual([{ code: 'LATE', reason: 'not_stackable' }]);
      expect(amounts(cart)).toEqual({ solo: 500n });
    });

    it('currency_mismatch is reported, never thrown or mixed', () => {
      const usd = Money.of(500n, 'USD');
      const cart = price(
        lines,
        [
          promo({ id: 'c', name: 'c', kind: 'fixed_off', code: 'USD5', amount: usd }),
          promo({
            id: 'm',
            name: 'm',
            kind: 'free_shipping',
            code: 'MIN',
            minSubtotal: Money.of(1n, 'EUR'),
          }),
        ],
        ['USD5', 'MIN'],
      );
      expect(reasons(cart)).toEqual({ USD5: 'currency_mismatch', MIN: 'currency_mismatch' });
      expect(cart.discounts).toEqual([]);
      expect(cart.net.amount).toBe(5000n);
    });

    it('not_applicable when the coupon matches no lines', () => {
      const cart = price(
        lines,
        [pct('c', 1000, { code: 'TAGGED', scope: { type: 'tags', tags: ['zzz'] } })],
        ['TAGGED'],
      );
      expect(cart.rejectedCoupons).toEqual([{ code: 'TAGGED', reason: 'not_applicable' }]);
    });

    it('exclusive_group when a better promotion in the group wins', () => {
      const cart = price(
        lines,
        [
          pct('auto', 5000, { exclusiveGroup: 'g' }),
          fixed('c', 100n, { code: 'SMALL', exclusiveGroup: 'g' }),
        ],
        ['SMALL'],
      );
      expect(cart.rejectedCoupons).toEqual([{ code: 'SMALL', reason: 'exclusive_group' }]);
      expect(amounts(cart)).toEqual({ auto: 2500n });
    });

    it('accepted and rejected codes are reported independently, sorted by code', () => {
      const cart = price(lines, [fixed('ok', 100n, { code: 'OK' })], ['zzz', 'ok', 'aaa']);
      expect(cart.rejectedCoupons).toEqual([
        { code: 'aaa', reason: 'unknown' },
        { code: 'zzz', reason: 'unknown' },
      ]);
    });
  });

  it('silently skips ineligible AUTOMATIC promotions', () => {
    const cart = price(lines, [
      pct('old', 1000, { endsAt: past(1) }),
      pct('later', 1000, { startsAt: future(1) }),
      pct('big', 1000, { minSubtotal: Money.of(1_000_000n, 'AUD') }),
      promo({ id: 'usd', name: 'usd', kind: 'fixed_off', amount: Money.of(5n, 'USD') }),
    ]);
    expect(cart.discounts).toEqual([]);
    expect(cart.rejectedCoupons).toEqual([]);
  });
});

describe('free_shipping', () => {
  it('sets the flag with a zero-amount discount and honours minSubtotal', () => {
    const lines = [line('a', 3000n, 1)];
    const p = freeShip('ship', { minSubtotal: Money.of(2500n, 'AUD') });
    const cart = price(lines, [p]);
    expect(cart.freeShipping).toBe(true);
    expect(cart.discounts[0]).toMatchObject({
      promotionId: 'ship',
      grantsFreeShipping: true,
      perLine: [],
    });
    expect(cart.discounts[0]?.amount.amount).toBe(0n);
    expect(cart.net.amount).toBe(3000n);
    const small = price([line('a', 2000n, 1)], [p]);
    expect(small.freeShipping).toBe(false);
    expect(small.discounts).toEqual([]);
  });

  it('does not apply to an empty cart', () => {
    expect(price([], [freeShip('ship')]).freeShipping).toBe(false);
  });
});

describe('stacking: non-stackable rule', () => {
  const lines = [line('a', 10_000n, 1)];

  it('a non-stackable promotion applied first blocks every later promotion', () => {
    const cart = price(lines, [
      pct('solo', 1000, { priority: 1, stackable: false }),
      pct('later', 1000, { priority: 2 }),
      freeShip('ship', { priority: 3 }),
    ]);
    expect(amounts(cart)).toEqual({ solo: 1000n });
    expect(cart.freeShipping).toBe(false);
  });

  it('a non-stackable promotion is itself blocked by anything applied before it', () => {
    const cart = price(lines, [
      pct('first', 1000, { priority: 1 }),
      pct('solo', 5000, { priority: 2, stackable: false }),
    ]);
    expect(amounts(cart)).toEqual({ first: 1000n });
  });

  it('stackable promotions combine freely', () => {
    const cart = price(lines, [pct('a', 1000, { priority: 1 }), pct('b', 1000, { priority: 2 })]);
    expect(amounts(cart)).toEqual({ a: 1000n, b: 900n });
  });

  it('a non-stackable promotion that applies nothing does not block', () => {
    const cart = price(lines, [
      pct('noop', 1000, { priority: 1, stackable: false, scope: { type: 'tags', tags: ['zzz'] } }),
      pct('b', 1000, { priority: 2 }),
    ]);
    expect(amounts(cart)).toEqual({ b: 1000n });
  });

  it('priority decides which non-stackable wins; ties by id', () => {
    const a = pct('a', 1000, { stackable: false });
    const b = pct('b', 5000, { stackable: false });
    expect(amounts(price(lines, [b, a]))).toEqual({ a: 1000n });
    const bWins = pct('b', 5000, { stackable: false, priority: 1 });
    expect(amounts(price(lines, [a, bWins]))).toEqual({ b: 5000n });
  });
});

describe('stacking: exclusive groups', () => {
  const lines = [line('a', 10_000n, 1)];

  it('applies only the largest discount in the group', () => {
    const cart = price(lines, [
      pct('ten', 1000, { exclusiveGroup: 'g' }),
      pct('twenty', 2000, { exclusiveGroup: 'g' }),
      fixed('five', 500n, { exclusiveGroup: 'g' }),
    ]);
    expect(amounts(cart)).toEqual({ twenty: 2000n });
  });

  it('breaks exact ties in favour of the earlier promotion (priority, then id)', () => {
    const cart = price(lines, [
      pct('b', 1000, { exclusiveGroup: 'g' }),
      fixed('a', 1000n, { exclusiveGroup: 'g' }),
    ]);
    expect(amounts(cart)).toEqual({ a: 1000n });
  });

  it('a group winner stacks with promotions outside the group', () => {
    const cart = price(lines, [
      pct('g1', 1000, { exclusiveGroup: 'g', priority: 1 }),
      pct('g2', 2000, { exclusiveGroup: 'g', priority: 2 }),
      freeShip('ship', { priority: 3 }),
    ]);
    expect(amounts(cart)).toEqual({ g2: 2000n, ship: 0n });
    expect(cart.freeShipping).toBe(true);
  });

  it('compares discounts against the running net at the position of the first member', () => {
    // 10% off first (priority 1), then group {fixed 800, 50% of running 9000 = 4500}: 50% wins.
    const cart = price(lines, [
      pct('base', 1000, { priority: 1 }),
      fixed('f', 800n, { exclusiveGroup: 'g', priority: 2 }),
      pct('half', 5000, { exclusiveGroup: 'g', priority: 3 }),
    ]);
    expect(amounts(cart)).toEqual({ base: 1000n, half: 4500n });
  });

  it('separate groups are independent', () => {
    const cart = price(lines, [
      pct('a1', 1000, { exclusiveGroup: 'ga', priority: 1 }),
      pct('a2', 500, { exclusiveGroup: 'ga', priority: 2 }),
      pct('b1', 1000, { exclusiveGroup: 'gb', priority: 3 }),
      pct('b2', 500, { exclusiveGroup: 'gb', priority: 4 }),
    ]);
    expect(Object.keys(amounts(cart))).toEqual(['a1', 'b1']);
  });

  it('members blocked by the non-stackable rule are not candidates', () => {
    const cart = price(lines, [
      pct('solo', 1000, { stackable: false, priority: 1 }),
      pct('g1', 5000, { exclusiveGroup: 'g', priority: 2 }),
    ]);
    expect(amounts(cart)).toEqual({ solo: 1000n });
  });

  it('a non-stackable group winner blocks later promotions', () => {
    const cart = price(lines, [
      pct('g1', 1000, { exclusiveGroup: 'g', priority: 1 }),
      pct('g2', 2000, { exclusiveGroup: 'g', priority: 2, stackable: false }),
      pct('later', 1000, { priority: 3 }),
    ]);
    // g2 is non-stackable but nothing was applied before the group is resolved, so it may win; then it blocks 'later'.
    expect(amounts(cart)).toEqual({ g2: 2000n });
  });
});

describe('buy_x_get_y', () => {
  it('same-item buy 1 get 1 free across quantities', () => {
    for (let qty = 1; qty <= 9; qty += 1) {
      const cart = price([line('a', 700n, qty)], [bxgy('b', 1, 1, { mode: 'same' })]);
      expect(cart.discountTotal.amount).toBe(BigInt(Math.floor(qty / 2)) * 700n);
    }
  });

  it('buy 2 get 1 free: free units = floor(qty / 3), full groups only', () => {
    for (let qty = 1; qty <= 12; qty += 1) {
      const cart = price([line('a', 250n, qty)], [bxgy('b', 2, 1, { mode: 'same' })]);
      expect(cart.discountTotal.amount).toBe(BigInt(Math.floor(qty / 3)) * 250n);
      assertInvariants(cart, {
        currency: 'AUD',
        lines: [line('a', 250n, qty)],
        promotions: [],
        couponCodes: [],
        now: NOW,
      });
    }
  });

  it('buy 1 get 2: needs the whole group present', () => {
    const p = bxgy('b', 1, 2, { mode: 'same' });
    expect(price([line('a', 100n, 2)], [p]).discountTotal.amount).toBe(0n);
    expect(price([line('a', 100n, 3)], [p]).discountTotal.amount).toBe(200n);
    expect(price([line('a', 100n, 5)], [p]).discountTotal.amount).toBe(200n);
    expect(price([line('a', 100n, 6)], [p]).discountTotal.amount).toBe(400n);
  });

  it('same mode never mixes lines', () => {
    const cart = price(
      [line('a', 100n, 1), line('b', 500n, 1)],
      [bxgy('b', 1, 1, { mode: 'same' })],
    );
    expect(cart.discounts).toEqual([]);
  });

  it('cheapest mode pools units across lines: cheapest of each group is free', () => {
    // sorted desc: 1000, 900, 800, 100 -> groups (1000, 900) (800, 100) -> free 900 + 100.
    const lines = [line('a', 1000n, 1), line('b', 900n, 1), line('c', 800n, 1), line('d', 100n, 1)];
    const cart = price(lines, [bxgy('b', 1, 1)]);
    expect(lineDiscounts(cart)).toEqual([0n, 900n, 0n, 100n]);
    expect(cart.discountTotal.amount).toBe(1000n);
  });

  it('cheapest mode: buy 2 get 1 across lines, with a partial trailing group ignored', () => {
    // units desc: 500,500,300,300,300,100,100 (7) -> groups of 3: (500,500,300) (300,300,100) + leftover (100)
    const lines = [line('a', 500n, 2), line('b', 300n, 3), line('c', 100n, 2)];
    const cart = price(lines, [bxgy('b', 2, 1)]);
    expect(lineDiscounts(cart)).toEqual([0n, 300n + 0n, 100n]);
    expect(cart.discountTotal.amount).toBe(400n);
  });

  it('cheapest mode spans a group across a line boundary', () => {
    // units desc: 500(x1),300(x1),300... buy 1 get 1: (500,300)(300,100)
    const lines = [line('a', 500n, 1), line('b', 300n, 2), line('c', 100n, 1)];
    const cart = price(lines, [bxgy('b', 1, 1)]);
    expect(lineDiscounts(cart)).toEqual([0n, 300n, 100n]);
  });

  it('limits to the scope and ignores other lines', () => {
    const lines = [
      line('a', 1000n, 1, { tags: ['bogo'] }),
      line('b', 200n, 1, { tags: ['bogo'] }),
      line('c', 50n, 1),
    ];
    const cart = price(lines, [bxgy('b', 1, 1, { scope: { type: 'tags', tags: ['bogo'] } })]);
    expect(lineDiscounts(cart)).toEqual([0n, 200n, 0n]);
    const byProduct = price(lines, [
      bxgy('b', 1, 1, { scope: { type: 'products', productIds: ['prod-a', 'prod-c'] } }),
    ]);
    expect(lineDiscounts(byProduct)).toEqual([0n, 0n, 50n]);
  });

  it('percent reward: half price on the rewarded units, half-up per line', () => {
    const cart = price(
      [line('a', 333n, 2)],
      [bxgy('b', 1, 1, { mode: 'same', reward: { type: 'percent', basisPoints: 5000 } })],
    );
    expect(cart.discountTotal.amount).toBe(167n); // 333 * 50% = 166.5 -> 167
  });

  it('is capped by the running net of the line (earlier discounts)', () => {
    const cart = price(
      [line('a', 1000n, 2)],
      [pct('p', 8000, { priority: 1 }), bxgy('b', 1, 1, { mode: 'same', priority: 2 })],
    );
    // after 80% off the line net is 400; a free unit is worth 1000 but only 400 remains.
    expect(amounts(cart)).toEqual({ p: 1600n, b: 400n });
    expect(cart.net.amount).toBe(0n);
  });

  it('ignores zero-priced lines', () => {
    const cart = price([line('a', 0n, 4)], [bxgy('b', 1, 1, { mode: 'same' })]);
    expect(cart.discounts).toEqual([]);
  });

  it('is deterministic on price ties (line id decides)', () => {
    const lines = [line('b', 100n, 1), line('a', 100n, 1)];
    const cart = price(lines, [bxgy('x', 1, 1)]);
    expect(lineDiscounts(cart)).toEqual([100n, 0n]); // sorted by id on a tie: 'a' is the bought unit, 'b' the free one
  });
});

describe('zero- and three-decimal currencies', () => {
  it('JPY (0 decimals): half-up on whole yen, allocation exact', () => {
    const lines = [line('a', 1005n, 1, { currency: 'JPY' })];
    const promotions = [pct('p', 1000)];
    const cart = price(lines, promotions, [], 'JPY');
    expect(cart.discountTotal.amount).toBe(101n); // 100.5 -> 101 yen
    expect(cart.net.toString()).toBe('904 JPY');
    const multi = price(
      [line('a', 333n, 1, { currency: 'JPY' }), line('b', 334n, 1, { currency: 'JPY' })],
      [promo({ id: 'f', name: 'f', kind: 'fixed_off', amount: Money.of(100n, 'JPY') })],
      [],
      'JPY',
    );
    expect(multi.discountTotal.amount).toBe(100n);
    expect(lineDiscounts(multi).reduce((a, b) => a + b, 0n)).toBe(100n);
    expect(multi.currency).toBe('JPY');
  });

  it('JPY cart rejects an AUD fixed coupon as a currency mismatch', () => {
    const cart = price(
      [line('a', 5000n, 1, { currency: 'JPY' })],
      [fixed('c', 500n, { code: 'AUD5' })],
      ['AUD5'],
      'JPY',
    );
    expect(cart.rejectedCoupons).toEqual([{ code: 'AUD5', reason: 'currency_mismatch' }]);
  });

  it('KWD (3 decimals): 1.235 KWD x3, 15% off, and a 0.500 KWD coupon', () => {
    const lines = [line('a', 1235n, 3, { currency: 'KWD' })];
    const promotions = [
      pct('p', 1500, { priority: 1 }),
      promo({
        id: 'f',
        name: 'f',
        kind: 'fixed_off',
        priority: 2,
        amount: Money.parse('0.500', 'KWD'),
      }),
    ];
    const cart = price(lines, promotions, [], 'KWD');
    // 3705 * 15% = 555.75 -> 556; then 500 off.
    expect(cart.subtotal.toString()).toBe('3.705 KWD');
    expect(amounts(cart)).toEqual({ p: 556n, f: 500n });
    expect(cart.net.toString()).toBe('2.649 KWD');
    assertInvariants(cart, { currency: 'KWD', lines, promotions, couponCodes: [], now: NOW });
  });

  it('KWD buy 2 get 1 with a percent reward', () => {
    const cart = price(
      [line('a', 1001n, 3, { currency: 'KWD' })],
      [bxgy('b', 2, 1, { mode: 'same', reward: { type: 'percent', basisPoints: 3333 } })],
      [],
      'KWD',
    );
    expect(cart.discountTotal.amount).toBe(334n); // 1001 * 33.33% = 333.6333 -> 334
  });
});

describe('values beyond float precision', () => {
  const BIG = 9_007_199_254_740_993n; // 2^53 + 1: not representable as a float

  it('percent_off is exact on huge unit prices', () => {
    const lines = [line('a', BIG, 3)];
    const cart = price(lines, [pct('p', 1000)]);
    const list = BIG * 3n;
    expect(cart.subtotal.amount).toBe(list);
    expect(cart.discountTotal.amount).toBe((list * 1000n + 5000n) / 10_000n);
    expect(cart.net.amount).toBe(list - cart.discountTotal.amount);
    assertInvariants(cart, { currency: 'AUD', lines, promotions: [], couponCodes: [], now: NOW });
  });

  it('a huge fixed discount allocates exactly across huge lines', () => {
    const lines = [line('a', BIG, 1), line('b', BIG + 2n, 7), line('c', 1n, 1)];
    const total = 12_345_678_901_234_567n;
    const p = promo({
      id: 'f',
      name: 'f',
      kind: 'fixed_off',
      amount: Money.of(total, 'AUD'),
    });
    const cart = price(lines, [p]);
    expect(cart.discountTotal.amount).toBe(total);
    expect(lineDiscounts(cart).reduce((a, b) => a + b, 0n)).toBe(total);
    assertInvariants(cart, { currency: 'AUD', lines, promotions: [], couponCodes: [], now: NOW });
  });

  it('buy_x_get_y handles the maximum safe-integer quantity without expanding units', () => {
    const qty = Number.MAX_SAFE_INTEGER; // 9_007_199_254_740_991
    const cart = price([line('a', BIG, qty)], [bxgy('b', 1, 1, { mode: 'same' })]);
    const free = BigInt(qty) / 2n; // 4_503_599_627_370_495
    expect(cart.discountTotal.amount).toBe(free * BIG);
    expect(cart.subtotal.amount).toBe(BIG * BigInt(qty));
    const pooled = price([line('a', BIG, qty), line('b', BIG - 2n, qty)], [bxgy('b', 2, 1)]);
    expect(pooled.discountTotal.amount).toBeGreaterThan(0n);
    assertInvariants(pooled, {
      currency: 'AUD',
      lines: [line('a', BIG, qty), line('b', BIG - 2n, qty)],
      promotions: [],
      couponCodes: [],
      now: NOW,
    });
  });
});

describe('PricingProvider', () => {
  it('defaultPricingProvider delegates to computePricing', async () => {
    const input: PricingInput = {
      currency: 'AUD',
      lines: [line('a', 1000n, 1)],
      promotions: [pct('p', 1000)],
      couponCodes: [],
      now: NOW,
    };
    expect(await defaultPricingProvider.compute(input)).toEqual(computePricing(input));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Property tests. A seeded PRNG (mulberry32) keeps every failure reproducible: the seed is in the test name.
// ---------------------------------------------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)] as T;
  }
  /** Random bigint with up to `digits` decimal digits. */
  big(digits: number): bigint {
    let out = '';
    const n = this.int(1, digits);
    for (let i = 0; i < n; i += 1) out += String(this.int(0, 9));
    return BigInt(out);
  }
  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
    }
    return copy;
  }
}

const TAGS = ['sale', 'new', 'gift', 'bulk'];
const CODES = ['A1', 'B2', 'C3', 'D4'];

function randomScope(rng: Rng, productIds: string[]): Record<string, unknown> {
  switch (rng.int(0, 2)) {
    case 0:
      return { type: 'order' };
    case 1:
      return { type: 'products', productIds: rng.shuffle(productIds).slice(0, rng.int(1, 2)) };
    default:
      return { type: 'tags', tags: rng.shuffle(TAGS).slice(0, rng.int(1, 2)) };
  }
}

function randomInput(seed: number, currency: string): PricingInput {
  const rng = new Rng(seed);
  const digits = currency === 'JPY' ? 6 : 8;
  const lines: PricingLine[] = [];
  const productIds: string[] = [];
  for (let i = 0; i < rng.int(0, 6); i += 1) {
    const productId = `prod-${rng.int(0, 3)}`;
    productIds.push(productId);
    lines.push(
      line(`L${i}`, rng.bool(0.1) ? 0n : rng.big(digits), rng.int(1, 25), {
        productId,
        tags: TAGS.filter(() => rng.bool(0.3)),
        currency,
      }),
    );
  }
  const promotions: PromotionDef[] = [];
  const count = rng.int(0, 9);
  for (let i = 0; i < count; i += 1) {
    const window = rng.pick<[Date | null, Date | null]>([
      [null, null],
      [null, null],
      [null, null],
      [future(1), null], // not started
      [null, past(1)], // expired
      [past(3), future(3)], // live
      [past(3), null],
      [null, future(3)],
    ]);
    const other = rng.bool(0.08) ? 'USD' : currency;
    const common = {
      id: `P${i}`,
      name: `Promo ${i}`,
      code: rng.bool(0.4) ? rng.pick(CODES) : null,
      priority: rng.int(0, 3), // small range so priority ties are common
      stackable: rng.bool(0.75),
      startsAt: window[0],
      endsAt: window[1],
      minSubtotal: rng.bool(0.2) ? Money.of(rng.big(digits - 2), other) : null,
      ...(rng.bool(0.3) ? { exclusiveGroup: rng.pick(['g1', 'g2']) } : {}),
    };
    const scope = randomScope(rng, productIds.length > 0 ? productIds : ['prod-0']);
    switch (rng.int(0, 3)) {
      case 0:
        promotions.push(
          promo({
            ...common,
            kind: 'percent_off',
            scope,
            basisPoints: rng.int(1, 10_000),
          } as PromotionInput),
        );
        break;
      case 1:
        promotions.push(
          promo({
            ...common,
            kind: 'fixed_off',
            scope,
            amount: Money.of(rng.big(digits + 1) + 1n, other),
          } as PromotionInput),
        );
        break;
      case 2:
        promotions.push(
          promo({
            ...common,
            kind: 'buy_x_get_y',
            scope,
            buyQuantity: rng.int(1, 4),
            getQuantity: rng.int(1, 3),
            reward: rng.bool()
              ? { type: 'free' }
              : { type: 'percent', basisPoints: rng.int(1, 10_000) },
            mode: rng.pick(['cheapest', 'same']),
          } as PromotionInput),
        );
        break;
      default:
        promotions.push(promo({ ...common, kind: 'free_shipping' } as PromotionInput));
    }
  }
  const couponCodes = [...CODES, 'NOPE']
    .filter(() => rng.bool(0.5))
    .map((c) => (rng.bool() ? c.toLowerCase() : c));
  return { currency, lines, promotions, couponCodes, now: NOW };
}

describe.each(['AUD', 'JPY', 'KWD'])('property tests (%s)', (currency) => {
  const SEEDS = 400;

  it(`(a)(b)(c) sums, non-negative net and net = subtotal - discounts hold for ${SEEDS} seeded carts`, () => {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const input = randomInput(seed, currency);
      try {
        assertInvariants(computePricing(input), input);
      } catch (error) {
        throw new Error(`invariant failed for seed ${seed} (${currency}): ${String(error)}`, {
          cause: error,
        });
      }
    }
  });

  it('(d) is deterministic and independent of promotion and coupon input order', () => {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const input = randomInput(seed, currency);
      const first = computePricing(input);
      expect(computePricing(input), `seed ${seed}`).toEqual(first);
      const rng = new Rng(seed + 10_000);
      const shuffled: PricingInput = {
        ...input,
        promotions: rng.shuffle(input.promotions),
        couponCodes: rng.shuffle(input.couponCodes),
      };
      expect(computePricing(shuffled), `seed ${seed} shuffled`).toEqual(first);
    }
  });

  it('never mutates its input', () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const input = randomInput(seed, currency);
      const before = structuredClone({
        codes: input.couponCodes,
        ids: input.promotions.map((p) => p.id),
        lines: input.lines.map((l) => [l.lineId, l.unitPrice.amount, l.quantity]),
      });
      computePricing(input);
      expect({
        codes: input.couponCodes,
        ids: input.promotions.map((p) => p.id),
        lines: input.lines.map((l) => [l.lineId, l.unitPrice.amount, l.quantity]),
      }).toEqual(before);
    }
  });

  it('every supplied code is either applied or reported exactly once', () => {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const input = randomInput(seed, currency);
      const cart = computePricing(input);
      const rejected = cart.rejectedCoupons.map((r) => r.code.toUpperCase());
      expect(new Set(rejected).size).toBe(rejected.length);
      const appliedCodes = new Set(
        cart.discounts.flatMap((d) => (d.code ? [d.code.toUpperCase()] : [])),
      );
      for (const code of new Set(input.couponCodes.map((c) => c.toUpperCase()))) {
        expect(
          appliedCodes.has(code) !== rejected.includes(code),
          `seed ${seed} code ${code}`,
        ).toBe(true);
      }
    }
  });

  it('at most one member of an exclusive group is applied; a non-stackable promotion is always alone-or-first', () => {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const input = randomInput(seed, currency);
      const cart = computePricing(input);
      const byId = new Map(input.promotions.map((p) => [p.id, p]));
      const groups = cart.discounts.flatMap((d) => {
        const g = byId.get(d.promotionId)?.exclusiveGroup;
        return g ? [g] : [];
      });
      expect(new Set(groups).size, `seed ${seed}`).toBe(groups.length);
      const index = cart.discounts.findIndex((d) => byId.get(d.promotionId)?.stackable === false);
      if (index >= 0) {
        expect(index, `seed ${seed}`).toBe(0);
        expect(cart.discounts, `seed ${seed}`).toHaveLength(1);
      }
    }
  });
});
