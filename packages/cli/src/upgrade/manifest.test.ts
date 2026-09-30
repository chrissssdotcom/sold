import { describe, expect, it } from 'vitest';
import { classify, globToRegExp, matchesAny, parseManifest } from './manifest';
import { FIXTURE_MANIFEST } from './fixture';

describe('ownership manifest', () => {
  const manifest = parseManifest(JSON.stringify(FIXTURE_MANIFEST), 'test');

  it('matches subtree, single-segment and literal patterns', () => {
    expect(globToRegExp('apps/**').test('apps/web/src/a.ts')).toBe(true);
    expect(globToRegExp('apps/**').test('apps')).toBe(false);
    expect(globToRegExp('apps/').test('apps/web/a.ts')).toBe(true);
    expect(globToRegExp('docs/*.md').test('docs/a.md')).toBe(true);
    expect(globToRegExp('docs/*.md').test('docs/sub/a.md')).toBe(false);
    expect(globToRegExp('**/package.json').test('package.json')).toBe(true);
    expect(globToRegExp('**/package.json').test('a/b/package.json')).toBe(true);
    expect(globToRegExp('.sold/base-version').test('.sold/base-version')).toBe(true);
    expect(globToRegExp('a.b').test('aXb')).toBe(false); // dots are literal
    expect(globToRegExp('file?.ts').test('file1.ts')).toBe(true);
    expect(matchesAny('x', [])).toBe(false);
  });

  it('classifies paths: generated > base > customer > unowned', () => {
    expect(classify('apps/web/a.ts', manifest)).toBe('base');
    expect(classify('extensions/loyalty/index.ts', manifest)).toBe('customer');
    expect(classify('sold.config.ts', manifest)).toBe('customer');
    expect(classify('pnpm-lock.yaml', manifest)).toBe('generated');
    expect(classify('.sold/base-version', manifest)).toBe('generated');
    expect(classify('.sold/base-manifest.json', manifest)).toBe('base');
    expect(classify('README.md', manifest)).toBe('unowned');
  });

  it('lets the more specific statement win', () => {
    const m = parseManifest(
      JSON.stringify({
        schemaVersion: 1,
        baseOwned: ['extensions/_template/**'],
        customerOwned: ['extensions/**'],
      }),
      'test',
    );
    expect(classify('extensions/_template/index.ts', m)).toBe('base');
    expect(classify('extensions/mine/index.ts', m)).toBe('customer');
  });

  it('rejects malformed manifests', () => {
    expect(() => parseManifest('{', 'x')).toThrow(/not valid JSON/);
    expect(() =>
      parseManifest(JSON.stringify({ schemaVersion: 2, baseOwned: ['a'], customerOwned: [] }), 'x'),
    ).toThrow(/invalid/);
    expect(() =>
      parseManifest(JSON.stringify({ schemaVersion: 1, baseOwned: [], customerOwned: [] }), 'x'),
    ).toThrow(/invalid/);
    expect(() =>
      parseManifest(
        JSON.stringify({ schemaVersion: 1, baseOwned: ['a'], customerOwned: [], extra: 1 }),
        'x',
      ),
    ).toThrow();
  });
});
