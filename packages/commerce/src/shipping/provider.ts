import { CurrencyMismatchError, Money } from '@sold/core';
import {
  parseShippingConfig,
  type ShippingConfigInput,
  type ShippingMethodConfig,
  type ShippingZoneConfig,
} from './schema';
import type { ShippingProvider, ShippingQuote, ShippingQuoteInput } from './types';

/**
 * Config-driven shipping engine.
 *
 * Rules (all of them are tested):
 *
 * 1. Zone selection: the MOST SPECIFIC matching zone wins, and only that zone is used (no fall-through, so a
 *    regional zone can deliberately restrict or price differently). Specificity: a zone listing the destination
 *    region (3) beats a country-list zone (2) beats the `*` catch-all (1). Equal specificity: the earlier zone in the
 *    config wins. No matching zone: empty result (cannot ship).
 * 2. Currency: method prices are declared per currency; a method with no price for the order currency is
 *    unavailable. Prices are never converted. A `free_over` method compares the subtotal with the threshold of the
 *    order currency only.
 * 3. Method pricing: `flat` = its price; `per_item` = price x total units; `weight_table` = the tier whose
 *    `maxGrams` is the first one >= the total weight (unit weight x quantity, summed; inclusive upper bound;
 *    heavier than the last bounded tier means unavailable); `free_over` = 0 when subtotal >= threshold, else
 *    `belowPrices` when configured, else unavailable.
 * 4. Promo: `freeShippingPromo` zeroes every AVAILABLE method with `promoEligible` (default true). It never makes an
 *    unavailable method available.
 * 5. Ordering: ascending amount, then method id (code-point order), so the result is deterministic.
 * 6. An empty result means checkout must refuse.
 */

const norm = (s: string): string => s.trim().toUpperCase();

function specificity(zone: ShippingZoneConfig, country: string, region: string): number {
  if (zone.countries === '*') return 1;
  if (!zone.countries.includes(country)) return 0;
  if (zone.regions === undefined) return 2;
  return zone.regions.includes(region) ? 3 : 0;
}

const priceFor = (prices: Record<string, Money>, currency: string): Money | undefined =>
  Object.hasOwn(prices, currency) ? prices[currency] : undefined;

interface Order {
  currency: string;
  subtotal: Money;
  totalGrams: bigint;
  totalUnits: bigint;
}

function priceMethod(method: ShippingMethodConfig, order: Order): Money | undefined {
  switch (method.type) {
    case 'flat':
      return priceFor(method.prices, order.currency);
    case 'per_item':
      return priceFor(method.prices, order.currency)?.times(order.totalUnits);
    case 'weight_table': {
      for (const tier of method.tiers) {
        if (tier.maxGrams === null || order.totalGrams <= BigInt(tier.maxGrams))
          return priceFor(tier.prices, order.currency);
      }
      return undefined;
    }
    case 'free_over': {
      const threshold = priceFor(method.threshold, order.currency);
      if (threshold === undefined) return undefined;
      if (order.subtotal.compare(threshold) >= 0) return Money.zero(order.currency);
      return method.belowPrices ? priceFor(method.belowPrices, order.currency) : undefined;
    }
  }
}

function assertSafeCount(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${what} must be a non-negative integer`);
}

/** Build a provider from a config (validated with Zod; throws `ZodError` on a bad config). */
export function createShippingProvider(configInput: ShippingConfigInput): ShippingProvider {
  const config = parseShippingConfig(configInput);

  return {
    quote(input: ShippingQuoteInput): ShippingQuote[] {
      const { currency } = input;
      Money.zero(currency); // validates the ISO code
      if (input.subtotal.currency !== currency)
        throw new CurrencyMismatchError(currency, input.subtotal.currency);

      let totalGrams = 0n;
      let totalUnits = 0n;
      for (const line of input.lines) {
        assertSafeCount(line.quantity, 'quantity');
        assertSafeCount(line.weightGrams, 'weightGrams');
        if (line.unitPrice.currency !== currency)
          throw new CurrencyMismatchError(currency, line.unitPrice.currency);
        totalUnits += BigInt(line.quantity);
        totalGrams += BigInt(line.weightGrams) * BigInt(line.quantity);
      }

      const country = norm(input.destination.country);
      const region = norm(input.destination.region);
      let zone: ShippingZoneConfig | undefined;
      let best = 0;
      for (const candidate of config.zones) {
        const score = specificity(candidate, country, region);
        if (score > best) {
          best = score;
          zone = candidate;
        }
      }
      if (!zone) return [];

      const order: Order = { currency, subtotal: input.subtotal, totalGrams, totalUnits };
      const quotes: ShippingQuote[] = [];
      for (const method of zone.methods) {
        const price = priceMethod(method, order);
        if (price === undefined) continue;
        const quote: ShippingQuote = {
          methodId: method.id,
          label: method.label,
          amount: input.freeShippingPromo && method.promoEligible ? Money.zero(currency) : price,
          estimatedDaysMin: method.estimatedDaysMin,
          estimatedDaysMax: method.estimatedDaysMax,
        };
        if (method.carrier !== undefined) quote.carrier = method.carrier;
        quotes.push(quote);
      }

      return quotes.sort((a, b) => {
        const byPrice = a.amount.compare(b.amount);
        if (byPrice !== 0) return byPrice;
        return a.methodId < b.methodId ? -1 : a.methodId > b.methodId ? 1 : 0;
      });
    },
  };
}
