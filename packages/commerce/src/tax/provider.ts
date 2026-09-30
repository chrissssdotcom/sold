import { CurrencyMismatchError, Money } from '@sold/core';
import type { Address } from '../contracts';
import { parseTaxTable, type TaxRule, type TaxTableInput } from './schema';
import type {
  TaxBreakdownEntry,
  TaxInput,
  TaxLineResult,
  TaxProvider,
  TaxRateAmount,
  TaxResult,
} from './types';

/**
 * Table-driven tax engine.
 *
 * Rules (all of them are tested):
 *
 * 1. Which components apply. For a line with category C, every rule that (a) matches the jurisdiction
 *    (destination country/region, or the seller's country/region for `origin`-sourced rules), (b) is effective at
 *    `now` (`effectiveFrom` inclusive, `effectiveTo` exclusive) and (c) has category C is a component; components
 *    are summed (state + local, or CA GST + PST). If nothing matches C, the `standard` rules are used instead
 *    (an unknown category is taxed as standard rather than silently untaxed). The one exception is the reserved
 *    category `exempt`: with no explicit `exempt` rule it is simply untaxed.
 * 2. No matching rule at all (e.g. the destination country is not in the table) means ZERO tax, not an error:
 *    the seller has no registration/nexus we know about. Checkout still succeeds; the table is the source of truth.
 *    A tax-exempt customer also yields zero tax and no components.
 * 3. Shipping is taxed with the `standard` rules whose `appliesToShipping` is true (a simplification: some
 *    jurisdictions tax shipping at the rate of the goods).
 * 4. Exclusive pricing (`pricesIncludeTax: false`): each component is `amount * rateBps / 10000` rounded HALF-UP
 *    (away from zero at exactly .5) to the minor unit, per line and per component; line tax = sum of components.
 * 5. Inclusive pricing (`pricesIncludeTax: true`): the amount is gross. With combined rate R = sum of component
 *    bps, line tax = gross - gross * 10000 / (10000 + R) = gross * R / (10000 + R), rounded ONCE, HALF-UP; the
 *    net is then gross - tax, so net + tax == gross exactly for every line. The line tax is split across
 *    components by largest-remainder allocation weighted by their bps, so components sum to the line tax exactly.
 * 6. Rounding happens per line (and once for shipping), never on the invoice total. `total` is exactly the sum of
 *    all line taxes plus the shipping tax; `breakdown` amounts sum to `total`.
 * 7. Negative amounts (refund lines) are accepted and rounded symmetrically (half away from zero).
 * 8. For tax-exempt customers on tax-inclusive prices the result is zero tax; whether the customer is then charged
 *    the gross or the net price is a pricing decision made by the caller.
 *
 * The bundled tables are illustrative, NOT legal or tax advice.
 */

const BPS_BASE = 10_000n;

interface CompiledRule extends TaxRule {
  fromMs: number;
  toMs: number;
}

interface Part {
  rule: CompiledRule;
  amount: Money;
}

const norm = (s: string): string => s.trim().toUpperCase();

function compile(rule: TaxRule): CompiledRule {
  return {
    ...rule,
    fromMs: rule.effectiveFrom === undefined ? -Infinity : Date.parse(rule.effectiveFrom),
    toMs: rule.effectiveTo === undefined ? Infinity : Date.parse(rule.effectiveTo),
  };
}

function matchesJurisdiction(rule: CompiledRule, destination: Address, origin: Address): boolean {
  if (rule.sourcing === 'origin') {
    if (norm(destination.country) !== rule.country || norm(origin.country) !== rule.country)
      return false;
    return rule.region === undefined || norm(origin.region) === rule.region;
  }
  if (norm(destination.country) !== rule.country) return false;
  return rule.region === undefined || norm(destination.region) === rule.region;
}

/** Apply a set of components to one amount; returns the per-component parts (in component order). */
function applyComponents(amount: Money, components: readonly CompiledRule[], inclusive: boolean) {
  if (components.length === 0) return [];
  if (!inclusive) {
    return components.map((rule) => ({
      rule,
      amount: amount.basisPoints(rule.rateBps, 'half-up'),
    }));
  }
  const combined = components.reduce((sum, r) => sum + BigInt(r.rateBps), 0n);
  if (combined === 0n)
    return components.map((rule) => ({ rule, amount: Money.zero(amount.currency) }));
  const tax = amount.multiply({ numerator: combined, denominator: BPS_BASE + combined }, 'half-up');
  const shares = tax.allocate(components.map((r) => BigInt(r.rateBps)));
  return components.map((rule, i) => ({ rule, amount: shares[i] as Money }));
}

function toRates(parts: readonly Part[]): TaxRateAmount[] {
  return parts.map((p) => ({ name: p.rule.name, rate: p.rule.rateBps, amount: p.amount }));
}

function sum(currency: string, parts: readonly Part[]): Money {
  return parts.reduce((acc, p) => acc.add(p.amount), Money.zero(currency));
}

function assertCurrency(money: Money, currency: string): void {
  if (money.currency !== currency) throw new CurrencyMismatchError(currency, money.currency);
}

/** Build a provider from a tax table (validated with Zod; throws `ZodError` on a bad table). */
export function createTaxProvider(tableInput: TaxTableInput): TaxProvider {
  const table = parseTaxTable(tableInput);
  const byCountry = new Map<string, CompiledRule[]>();
  for (const rule of table.rules) {
    const list = byCountry.get(rule.country) ?? [];
    list.push(compile(rule));
    byCountry.set(rule.country, list);
  }

  return {
    calculate(input: TaxInput): TaxResult {
      const { currency, pricesIncludeTax: inclusive } = input;
      const zero = Money.zero(currency);
      assertCurrency(input.shipping, currency);
      for (const line of input.lines) assertCurrency(line.net, currency);

      const nowMs = input.now.getTime();
      if (!Number.isFinite(nowMs)) throw new RangeError('now must be a valid Date');

      const exempt = input.customerTaxExempt === true;
      const active = exempt
        ? []
        : (byCountry.get(norm(input.destination.country)) ?? []).filter(
            (r) =>
              r.fromMs <= nowMs &&
              nowMs < r.toMs &&
              matchesJurisdiction(r, input.destination, input.origin),
          );

      const componentsFor = (category: string): CompiledRule[] => {
        const exact = active.filter((r) => r.category === category);
        if (exact.length > 0 || category === 'exempt') return exact;
        return active.filter((r) => r.category === 'standard');
      };
      const shippingComponents = active.filter(
        (r) => r.category === 'standard' && r.appliesToShipping,
      );

      const breakdown = new Map<string, TaxBreakdownEntry>();
      const record = (amount: Money, parts: readonly Part[]): void => {
        // The tax-exclusive base a component applied to: the amount itself, or the amount minus the line tax.
        const base = amount.subtract(sum(currency, parts));
        for (const part of parts) {
          const key = `${part.rule.name}\u0000${part.rule.rateBps}`;
          const existing = breakdown.get(key);
          const taxable = inclusive ? base : amount;
          if (existing) {
            existing.taxable = existing.taxable.add(taxable);
            existing.amount = existing.amount.add(part.amount);
          } else {
            breakdown.set(key, {
              name: part.rule.name,
              rateBps: part.rule.rateBps,
              taxable,
              amount: part.amount,
            });
          }
        }
      };

      let total = zero;
      const lines: TaxLineResult[] = input.lines.map((line) => {
        const parts = applyComponents(line.net, componentsFor(line.taxCategory), inclusive);
        record(line.net, parts);
        const tax = sum(currency, parts);
        total = total.add(tax);
        return { lineId: line.lineId, tax, rates: toRates(parts) };
      });

      const shippingParts = applyComponents(input.shipping, shippingComponents, inclusive);
      record(input.shipping, shippingParts);
      const shippingTax = sum(currency, shippingParts);
      total = total.add(shippingTax);

      const sorted = [...breakdown.values()].sort((a, b) =>
        a.name === b.name ? a.rateBps - b.rateBps : a.name < b.name ? -1 : 1,
      );

      return {
        lines,
        shipping: { tax: shippingTax, rates: toRates(shippingParts) },
        total,
        pricesIncludeTax: inclusive,
        breakdown: sorted,
      };
    },
  };
}
