import { describe, expect, it } from 'vitest';
import { TAX_TABLES_DISCLAIMER, defaultTaxTable } from './tables';

describe('default tax tables', () => {
  it('validate and cover AU, NZ, GB, JP and the illustrative US states', () => {
    const countries = new Set(defaultTaxTable.rules.map((r) => r.country));
    expect([...countries].sort()).toEqual(['AU', 'GB', 'JP', 'NZ', 'US']);
  });

  it('have the documented headline rates', () => {
    const rate = (country: string, category: string): number | undefined =>
      defaultTaxTable.rules.find((r) => r.country === country && r.category === category)?.rateBps;
    expect(rate('AU', 'standard')).toBe(1000);
    expect(rate('AU', 'exempt')).toBe(0);
    expect(rate('NZ', 'standard')).toBe(1500);
    expect(rate('GB', 'standard')).toBe(2000);
    expect(rate('GB', 'reduced')).toBe(500);
    expect(rate('GB', 'zero')).toBe(0);
    expect(rate('JP', 'standard')).toBe(1000);
  });

  it('label the US table as origin-sourced and illustrative', () => {
    const us = defaultTaxTable.rules.filter((r) => r.country === 'US');
    expect(us.length).toBeGreaterThan(0);
    expect(us.every((r) => r.sourcing === 'origin' && r.region !== undefined)).toBe(true);
    expect(TAX_TABLES_DISCLAIMER).toMatch(/not legal or tax advice/);
  });
});
