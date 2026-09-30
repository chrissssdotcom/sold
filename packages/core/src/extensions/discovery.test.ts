import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defineConfig } from '../config';
import {
  discoverExtensions,
  DiscoveryError,
  firstPartyDirectories,
  renderRegistryModule,
} from './discovery';

const repoRoot = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const config = (extensions: unknown[]) =>
  defineConfig({
    instance: { name: 'T', customer: 'demo' },
    currencies: { base: 'AUD', enabled: [{ code: 'AUD' }] },
    locales: { default: 'en-AU', enabled: ['en-AU'] },
    extensions: extensions as never,
    services: { 'pricing.rounding': 'charm-pricing' },
  });

describe('discoverExtensions (against the real repository)', () => {
  it('discovers loyalty-points as a first-party extension with its migrations', async () => {
    const r = await discoverExtensions(repoRoot, async () => config(['loyalty-points']));
    expect(r.extensions.map((e) => [e.name, e.origin, e.enabled])).toEqual([
      ['loyalty-points', 'first-party', true],
    ]);
    expect(r.extensions[0]?.migrationFiles).toEqual(['0001_init.sql']);
    expect(r.services).toEqual({ 'pricing.rounding': 'charm-pricing' });
    expect(r.warnings).toEqual([]);
  });

  it('keeps disabled extensions (their onDisable hook needs the manifest) and warns about installed-but-unconfigured ones', async () => {
    const off = await discoverExtensions(repoRoot, async () =>
      config([{ name: 'loyalty-points', enabled: false }]),
    );
    expect(off.extensions[0]?.enabled).toBe(false);
    const none = await discoverExtensions(repoRoot, async () => config([]));
    expect(none.extensions).toEqual([]);
    expect(none.warnings.join()).toMatch(/loyalty-points.*installed but not listed/);
  });

  it('fails with every problem listed when a configured extension is missing', async () => {
    const attempt = discoverExtensions(repoRoot, async () =>
      config(['loyalty-points', 'ghost', 'phantom']),
    );
    await expect(attempt).rejects.toBeInstanceOf(DiscoveryError);
    await expect(attempt).rejects.toThrow(/ghost.*does not exist[\s\S]*phantom.*does not exist/);
  });

  it('reads first-party directories from the ownership manifest and ignores the template', async () => {
    const dirs = await firstPartyDirectories(repoRoot);
    expect(dirs.has('loyalty-points')).toBe(true);
    expect([...dirs].some((d) => d.startsWith('_'))).toBe(false);
  });
});

describe('renderRegistryModule', () => {
  it('imports exactly the configured extensions with paths relative to the generated file', async () => {
    const r = await discoverExtensions(repoRoot, async () => config(['loyalty-points']));
    const out = renderRegistryModule(r, resolve(repoRoot, 'apps/web/.generated/extensions.ts'));
    expect(out).toContain(
      "import loyaltyPoints from '../../../extensions/loyalty-points/src/index';",
    );
    expect(out).toContain("{ manifest: loyaltyPoints, origin: 'first-party' }");
    expect(out).toContain('"loyalty-points": [\n    "0001_init.sql"\n  ]');
    expect(out).toContain('GENERATED');
  });

  it('is valid, empty-safe output for zero extensions', async () => {
    const r = await discoverExtensions(repoRoot, async () => config([]));
    const out = renderRegistryModule(r, resolve(repoRoot, 'apps/web/.generated/extensions.ts'));
    expect(out).toContain('export const candidates: ExtensionCandidate[] = [\n];');
    expect(out).not.toContain('import loyalty');
  });
});
