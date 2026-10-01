import { describe, expect, it } from 'vitest';
import { assign, bucketOf } from './flags';

describe('flag assignment', () => {
  it('is deterministic and independent of call order', () => {
    const a = assign(
      'checkout-v2',
      true,
      {
        rolloutPercent: 50,
        variants: [
          { name: 'a', weight: 1 },
          { name: 'b', weight: 1 },
        ],
      },
      'visitor-1',
    );
    for (let i = 0; i < 5; i++)
      expect(
        assign(
          'checkout-v2',
          true,
          {
            rolloutPercent: 50,
            variants: [
              { name: 'a', weight: 1 },
              { name: 'b', weight: 1 },
            ],
          },
          'visitor-1',
        ),
      ).toEqual(a);
  });

  it('a disabled flag exposes nobody, even the allow list', () => {
    expect(assign('f', false, { allowList: ['x'], rolloutPercent: 100 }, 'x')).toEqual({
      enabled: false,
      variant: null,
    });
  });

  it('rollout percentages are honoured within statistical tolerance', () => {
    for (const pct of [0, 1, 10, 50, 90, 100]) {
      let on = 0;
      const n = 20_000;
      for (let i = 0; i < n; i++)
        if (assign('promo', true, { rolloutPercent: pct }, `v${i}`).enabled) on++;
      expect(Math.abs(on / n - pct / 100), `${pct}%`).toBeLessThan(0.015);
    }
  });

  it('growing a rollout never removes anyone who already had it', () => {
    for (let i = 0; i < 2000; i++) {
      const id = `v${i}`;
      if (assign('grow', true, { rolloutPercent: 20 }, id).enabled)
        expect(assign('grow', true, { rolloutPercent: 60 }, id).enabled).toBe(true);
    }
  });

  it('the allow list always gets the flag, at 0 %', () => {
    expect(
      assign('f', true, { rolloutPercent: 0, allowList: ['staff-1'] }, 'staff-1').enabled,
    ).toBe(true);
    expect(assign('f', true, { rolloutPercent: 0, allowList: ['staff-1'] }, 'other').enabled).toBe(
      false,
    );
  });

  it('variants split by weight and are not skewed by the rollout bucket', () => {
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    let exposed = 0;
    const n = 30_000;
    for (let i = 0; i < n; i++) {
      const r = assign(
        'exp',
        true,
        {
          rolloutPercent: 20,
          variants: [
            { name: 'a', weight: 50 },
            { name: 'b', weight: 30 },
            { name: 'c', weight: 20 },
          ],
        },
        `v${i}`,
      );
      if (r.enabled) {
        exposed++;
        counts[r.variant!]!++;
      }
    }
    expect(exposed / n).toBeGreaterThan(0.18);
    expect(exposed / n).toBeLessThan(0.22);
    expect(counts['a']! / exposed).toBeGreaterThan(0.46);
    expect(counts['a']! / exposed).toBeLessThan(0.54);
    expect(counts['b']! / exposed).toBeGreaterThan(0.26);
    expect(counts['c']! / exposed).toBeGreaterThan(0.16);
  });

  it('buckets are in range and the flag key reshuffles', () => {
    for (let i = 0; i < 100; i++) expect(bucketOf('k', `v${i}`)).toBeLessThan(10_000);
    const same = Array.from(
      { length: 200 },
      (_, i) => bucketOf('k1', `v${i}`) === bucketOf('k2', `v${i}`),
    ).filter(Boolean).length;
    expect(same).toBeLessThan(5);
  });
});
