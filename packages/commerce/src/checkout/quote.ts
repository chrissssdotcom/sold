import { Money } from '@sold/core';
import { and, eq, inArray, schema } from '@sold/db';
import type { Address, PricingLine } from '../contracts';
import { NotFoundError, ValidationError } from '../errors';
import type { CartRecord, CartService } from '../cart';
import type { PricedCart, PricingProvider } from '../pricing';
import type { PromotionService } from '../promotions';
import type { ShippingProvider, ShippingQuote } from '../shipping';
import type { TaxProvider, TaxResult } from '../tax';
import type { DbOrTx } from '../types';
import type { CheckoutConfig } from './config';

const { cartLines, productVariants, products, variantPrices } = schema;

export interface QuoteLine extends PricingLine {
  cartLineId: string;
  /** Storefront display data, carried so a cart can be rendered from one quote without further queries. */
  handle: string;
  image: string | null;
}

export interface Quote {
  cartId: string;
  cartVersion: number;
  currency: string;
  lines: QuoteLine[];
  pricing: PricedCart;
  shippingOptions: ShippingQuote[];
  /** The chosen method, or null when none was requested/available. */
  shipping: ShippingQuote | null;
  tax: TaxResult | null;
  pricesIncludeTax: boolean;
  subtotal: Money;
  discountTotal: Money;
  shippingTotal: Money;
  taxTotal: Money;
  /** What the customer pays. Inclusive pricing: tax is already inside subtotal/shipping. */
  total: Money;
}

export interface QuoteRequest {
  cartId: string;
  destination: Address;
  shippingMethodId?: string;
  customerTaxExempt?: boolean;
}

export interface QuoteDeps {
  carts: CartService;
  promotions: PromotionService;
  pricing: PricingProvider;
  tax: TaxProvider;
  shipping: ShippingProvider;
  config: CheckoutConfig;
  now?: () => Date;
  onInvalidPromotion?: (id: string, error: unknown) => void;
}

/**
 * Prices a cart end to end: list prices -> promotions -> shipping options -> tax -> total. It is a pure function of
 * database state plus the request, so checkout can run it twice (before and inside the order transaction) and
 * refuse to place an order whose price moved under the shopper.
 */
export class QuoteService {
  constructor(private readonly deps: QuoteDeps) {}

  async quote(db: DbOrTx, req: QuoteRequest, cart?: CartRecord): Promise<Quote> {
    const now = (this.deps.now ?? (() => new Date()))();
    const record = cart ?? (await this.deps.carts.get(db, req.cartId));
    const lines = await this.loadLines(db, record);
    if (lines.length === 0) throw new ValidationError('The cart is empty');

    const promotions = await this.deps.promotions.candidates(
      db,
      record.couponCodes,
      now,
      this.deps.onInvalidPromotion,
    );
    const pricing = await this.deps.pricing.compute({
      currency: record.currency,
      lines,
      promotions,
      couponCodes: record.couponCodes,
      now,
    });

    const shippingOptions = await this.deps.shipping.quote({
      currency: record.currency,
      destination: req.destination,
      lines: lines.map((l) => ({
        lineId: l.lineId,
        quantity: l.quantity,
        weightGrams: l.weightGrams,
        unitPrice: l.unitPrice,
      })),
      subtotal: pricing.net,
      freeShippingPromo: pricing.freeShipping,
      now,
    });
    const shipping = req.shippingMethodId
      ? (shippingOptions.find((o) => o.methodId === req.shippingMethodId) ?? null)
      : null;
    if (req.shippingMethodId && !shipping)
      throw new ValidationError('That shipping method is not available for this order', {
        shippingMethodId: req.shippingMethodId,
      });

    const zero = Money.zero(record.currency);
    const shippingTotal = shipping?.amount ?? zero;
    const tax = shipping
      ? await this.deps.tax.calculate({
          currency: record.currency,
          lines: pricing.lines.map((pl) => ({
            lineId: pl.lineId,
            net: pl.net,
            quantity: pl.quantity,
            taxCategory: lines.find((l) => l.lineId === pl.lineId)?.taxCategory ?? 'standard',
          })),
          shipping: shippingTotal,
          destination: req.destination,
          origin: this.deps.config.origin,
          pricesIncludeTax: this.deps.config.pricesIncludeTax,
          customerTaxExempt: req.customerTaxExempt ?? false,
          now,
        })
      : null;
    const taxTotal = tax?.total ?? zero;
    const inclusive = this.deps.config.pricesIncludeTax;
    const total = pricing.net.add(shippingTotal).add(inclusive ? zero : taxTotal);

    return {
      cartId: record.id,
      cartVersion: record.version,
      currency: record.currency,
      lines,
      pricing,
      shippingOptions,
      shipping,
      tax,
      pricesIncludeTax: inclusive,
      subtotal: pricing.subtotal,
      discountTotal: pricing.discountTotal,
      shippingTotal,
      taxTotal,
      total,
    };
  }

  /** Join cart lines to variants, products and prices in exactly three queries (no N+1). */
  private async loadLines(db: DbOrTx, cart: CartRecord): Promise<QuoteLine[]> {
    if (cart.lines.length === 0) return [];
    const variantIds = cart.lines.map((l) => l.variantId);
    const rows = await db
      .select({
        cartLineId: cartLines.id,
        variantId: productVariants.id,
        sku: productVariants.sku,
        variantTitle: productVariants.title,
        weightGrams: productVariants.weightGrams,
        productId: products.id,
        productHandle: products.handle,
        productTitle: products.title,
        tags: products.tags,
        attributes: products.attributes,
        status: products.status,
      })
      .from(cartLines)
      .innerJoin(productVariants, eq(productVariants.id, cartLines.variantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(eq(cartLines.cartId, cart.id));
    const prices = await db
      .select()
      .from(variantPrices)
      .where(
        and(
          inArray(variantPrices.variantId, variantIds),
          eq(variantPrices.currency, cart.currency),
        ),
      );
    const priceByVariant = new Map(prices.map((p) => [p.variantId, p.amount]));
    const byVariant = new Map(rows.map((r) => [r.variantId, r]));
    return cart.lines.map((line) => {
      const row = byVariant.get(line.variantId);
      if (!row) throw new NotFoundError('Variant', line.variantId);
      if (row.status !== 'active')
        throw new ValidationError(`"${row.productTitle}" is no longer available`, {
          variantId: line.variantId,
        });
      const price = priceByVariant.get(line.variantId);
      if (price === undefined)
        throw new ValidationError(`"${row.productTitle}" is not sold in ${cart.currency}`, {
          variantId: line.variantId,
        });
      const taxCategory = (row.attributes as { taxCategory?: unknown }).taxCategory;
      return {
        cartLineId: line.id,
        handle: row.productHandle,
        image: firstImage((row.attributes as { images?: unknown }).images),
        lineId: line.id,
        variantId: line.variantId,
        sku: row.sku,
        title: row.variantTitle ? `${row.productTitle} - ${row.variantTitle}` : row.productTitle,
        quantity: line.quantity,
        unitPrice: Money.of(price, cart.currency),
        weightGrams: row.weightGrams,
        productId: row.productId,
        tags: row.tags,
        taxCategory: typeof taxCategory === 'string' ? taxCategory : 'standard',
      };
    });
  }
}

function firstImage(images: unknown): string | null {
  return Array.isArray(images) && typeof images[0] === 'string' ? images[0] : null;
}
