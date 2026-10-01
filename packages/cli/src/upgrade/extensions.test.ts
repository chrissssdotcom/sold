import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, tempDir, writeTree } from '../testing';
import { checkExtensionCompatibility } from './extensions';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanup(d);
});

function withExtensions(files: Record<string, unknown>): string {
  const dir = tempDir();
  dirs.push(dir);
  writeTree(
    dir,
    Object.fromEntries(
      Object.entries(files).map(([p, v]) => [p, typeof v === 'string' ? v : JSON.stringify(v)]),
    ),
  );
  return dir;
}

describe('extension compatibility report', () => {
  it('reports compatible, incompatible and unknown extensions against the target version', async () => {
    const dir = withExtensions({
      'extensions/ok/package.json': {
        name: '@demo/ok',
        sold: { requires: { base: '>=1.0.0 <2.0.0' } },
      },
      'extensions/old/package.json': { name: '@demo/old', sold: { requires: { base: '^1.0.0' } } },
      'extensions/silent/package.json': { name: '@demo/silent' },
      'extensions/typo/package.json': {
        name: '@demo/typo',
        sold: { requires: { base: 'not a range' } },
      },
      'extensions/_template/package.json': { name: '@sold/template' },
      'extensions/docs/README.md': 'no package here',
    });
    const report = await checkExtensionCompatibility(dir, '2.0.0');
    expect(report.map((r) => [r.name, r.status])).toEqual([
      ['@demo/ok', 'incompatible'],
      ['@demo/old', 'incompatible'],
      ['@demo/silent', 'unknown'],
      ['@demo/typo', 'unknown'],
    ]);
    const forOneOne = await checkExtensionCompatibility(dir, '1.1.0');
    expect(forOneOne.map((r) => r.status)).toEqual([
      'compatible',
      'compatible',
      'unknown',
      'unknown',
    ]);
    expect(report[0]?.reason).toBe('requires base >=1.0.0 <2.0.0, target is 2.0.0');
  });

  it('treats prerelease targets against ranges sensibly', async () => {
    const dir = withExtensions({
      'extensions/a/package.json': { name: 'a', sold: { requires: { base: '>=1.0.0' } } },
    });
    expect((await checkExtensionCompatibility(dir, '1.5.0-rc.1'))[0]?.status).toBe('compatible');
  });

  it('returns an empty report when there is no extensions directory', async () => {
    expect(await checkExtensionCompatibility(tempDir(), '1.0.0')).toEqual([]);
  });

  it('does not judge Base-owned (first-party) extensions by their installed range: the upgrade replaces them', async () => {
    const dir = withExtensions({
      'extensions/reviews/package.json': {
        name: '@sold-ext/reviews',
        sold: { requires: { base: '^0.1.0' } },
      },
      'extensions/acme-loyalty/package.json': {
        name: '@acme/loyalty',
        sold: { requires: { base: '^0.1.0' } },
      },
    });
    const baseOwned = (p: string) => p.startsWith('extensions/reviews/');
    const report = await checkExtensionCompatibility(dir, '0.2.0', { baseOwned });
    expect(report.map((r) => [r.name, r.status])).toEqual([
      ['@acme/loyalty', 'incompatible'], // the customer's own extension is still judged
      ['@sold-ext/reviews', 'replaced'],
    ]);
    // After the files are replaced (upgrade:apply) nothing is skipped: the target's own range is checked for real.
    expect(
      (await checkExtensionCompatibility(dir, '0.2.0')).map((r) => [r.name, r.status]),
    ).toContainEqual(['@sold-ext/reviews', 'incompatible']);
  });
});
