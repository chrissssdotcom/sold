import { describe, expect, it } from 'vitest';
import { fromJsonSafe, toJsonSafe } from './serialization';

describe('json-safe codec', () => {
  it('round-trips bigint money and dates through JSON.stringify', () => {
    const event = {
      total: { amount: 9_007_199_254_740_993n, currency: 'JPY' },
      placedAt: new Date('2026-09-30T00:00:00Z'),
      lines: [{ qty: 2 }],
      note: null,
    };
    const wire = JSON.parse(JSON.stringify(toJsonSafe(event)));
    const back = fromJsonSafe<typeof event>(wire);
    expect(back.total.amount).toBe(9_007_199_254_740_993n); // beyond Number.MAX_SAFE_INTEGER
    expect(back.placedAt).toEqual(event.placedAt);
    expect(back.lines).toEqual([{ qty: 2 }]);
    expect(back.note).toBeNull();
  });

  it('drops undefined fields and rejects unsupported values', () => {
    expect(toJsonSafe({ a: 1, b: undefined })).toEqual({ a: 1 });
    expect(() => toJsonSafe({ f: () => 1 })).toThrow(TypeError);
    expect(() => toJsonSafe(Number.NaN)).toThrow(TypeError);
  });
});
