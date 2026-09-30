import { defineExtension, type ExtensionManifest } from '@sold/extension-sdk';
import { describe, expect, it } from 'vitest';
import { ExtensionLoadError, resolveLoadOrder, type ExtensionCandidate } from './load-order';

const ext = (
  name: string,
  over: { version?: string; base?: string; requires?: Record<string, string> } = {},
): ExtensionManifest =>
  defineExtension({
    name,
    version: over.version ?? '1.0.0',
    requires: { base: over.base ?? '^0.1.0', extensions: over.requires ?? {} },
    performance: { hotPath: false },
  });

const cand = (
  m: ExtensionManifest,
  origin: ExtensionCandidate['origin'] = 'instance',
): ExtensionCandidate => ({ manifest: m, origin });
const on = (...names: string[]) => names.map((name) => ({ name, enabled: true }));
const orderOf = (r: { manifest: ExtensionManifest }[]) => r.map((x) => x.manifest.name);
const failure = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ExtensionLoadError);
    return (e as ExtensionLoadError).message;
  }
  throw new Error('expected failure');
};

describe('resolveLoadOrder', () => {
  it('loads with zero extensions', () => {
    expect(resolveLoadOrder({ baseVersion: '0.1.0', candidates: [], entries: [] })).toEqual([]);
  });

  it('follows config order when there are no dependencies, regardless of candidate order', () => {
    const r = resolveLoadOrder({
      baseVersion: '0.1.0',
      candidates: [cand(ext('alpha')), cand(ext('beta')), cand(ext('gamma'))],
      entries: on('gamma', 'alpha', 'beta'),
    });
    expect(orderOf(r)).toEqual(['gamma', 'alpha', 'beta']);
    expect(r.map((x) => x.index)).toEqual([0, 1, 2]);
  });

  it('puts dependencies first and is deterministic', () => {
    const candidates = [
      cand(ext('reviews-ui', { requires: { reviews: '^1.0.0' } })),
      cand(ext('reviews')),
      cand(ext('loyalty')),
    ];
    const a = orderOf(
      resolveLoadOrder({
        baseVersion: '0.1.0',
        candidates,
        entries: on('reviews-ui', 'loyalty', 'reviews'),
      }),
    );
    const b = orderOf(
      resolveLoadOrder({
        baseVersion: '0.1.0',
        candidates: [...candidates].reverse(),
        entries: on('reviews-ui', 'loyalty', 'reviews'),
      }),
    );
    expect(a).toEqual(['loyalty', 'reviews', 'reviews-ui']);
    expect(b).toEqual(a);
  });

  it('ignores disabled extensions and does not load them', () => {
    const r = resolveLoadOrder({
      baseVersion: '0.1.0',
      candidates: [cand(ext('alpha')), cand(ext('beta'))],
      entries: [
        { name: 'alpha', enabled: true },
        { name: 'beta', enabled: false },
      ],
    });
    expect(orderOf(r)).toEqual(['alpha']);
  });

  it('fails when Base is outside the required range, naming both versions', () => {
    const msg = failure(() =>
      resolveLoadOrder({
        baseVersion: '1.2.0',
        candidates: [cand(ext('alpha', { base: '^0.1.0' }))],
        entries: on('alpha'),
      }),
    );
    expect(msg).toMatch(/requires Base \^0\.1\.0 but this is Base 1\.2\.0/);
  });

  it('accepts pre-release Base builds against ranges', () => {
    expect(() =>
      resolveLoadOrder({
        baseVersion: '0.1.1-rc.1',
        candidates: [cand(ext('alpha', { base: '^0.1.0' }))],
        entries: on('alpha'),
      }),
    ).not.toThrow();
  });

  it('fails on unknown extensions, missing/disabled/incompatible dependencies', () => {
    expect(
      failure(() =>
        resolveLoadOrder({ baseVersion: '0.1.0', candidates: [], entries: on('ghost') }),
      ),
    ).toMatch(/no such extension is installed/);
    const needs = ext('alpha', { requires: { beta: '^2.0.0' } });
    expect(
      failure(() =>
        resolveLoadOrder({ baseVersion: '0.1.0', candidates: [cand(needs)], entries: on('alpha') }),
      ),
    ).toMatch(/"beta".*not installed/);
    expect(
      failure(() =>
        resolveLoadOrder({
          baseVersion: '0.1.0',
          candidates: [cand(needs), cand(ext('beta', { version: '2.0.0' }))],
          entries: [
            { name: 'alpha', enabled: true },
            { name: 'beta', enabled: false },
          ],
        }),
      ),
    ).toMatch(/not enabled/);
    expect(
      failure(() =>
        resolveLoadOrder({
          baseVersion: '0.1.0',
          candidates: [cand(needs), cand(ext('beta', { version: '1.5.0' }))],
          entries: on('alpha', 'beta'),
        }),
      ),
    ).toMatch(/requires "beta" \^2\.0\.0 but "beta" is 1\.5\.0/);
  });

  it('detects cycles and prints the path', () => {
    const msg = failure(() =>
      resolveLoadOrder({
        baseVersion: '0.1.0',
        candidates: [
          cand(ext('alpha', { requires: { beta: '*' } })),
          cand(ext('beta', { requires: { gamma: '*' } })),
          cand(ext('gamma', { requires: { alpha: '*' } })),
        ],
        entries: on('alpha', 'beta', 'gamma'),
      }),
    );
    expect(msg).toMatch(/dependency cycle: alpha -> beta -> gamma -> alpha/);
  });

  it('reports every problem at once', () => {
    const msg = failure(() =>
      resolveLoadOrder({
        baseVersion: '9.0.0',
        candidates: [cand(ext('alpha', { requires: { nope: '*' } }))],
        entries: [...on('alpha', 'ghost'), { name: 'alpha', enabled: true }],
      }),
    );
    expect(msg).toMatch(/listed more than once/);
    expect(msg).toMatch(/ghost/);
    expect(msg).toMatch(/requires Base/);
    expect(msg).toMatch(/"nope"/);
  });

  it('rejects the same extension provided twice', () => {
    expect(
      failure(() =>
        resolveLoadOrder({
          baseVersion: '0.1.0',
          candidates: [cand(ext('alpha')), cand(ext('alpha'))],
          entries: on('alpha'),
        }),
      ),
    ).toMatch(/provided more than once/);
  });

  it('carries the origin through for override precedence', () => {
    const r = resolveLoadOrder({
      baseVersion: '0.1.0',
      candidates: [cand(ext('alpha'), 'first-party')],
      entries: on('alpha'),
    });
    expect(r[0]?.origin).toBe('first-party');
  });
});
