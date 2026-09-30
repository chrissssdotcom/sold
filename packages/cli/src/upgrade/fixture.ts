/** A local "upstream" Base repository plus an instance repository pinned to it (test fixture). */
import { join } from 'node:path';
import { commitAll, git, initRepo, tempDir, writeTree } from '../testing';

export const FIXTURE_MANIFEST = {
  schemaVersion: 1,
  baseOwned: ['apps/**', 'packages/**', 'upgrades/**', 'CHANGELOG.md', '.sold/base-manifest.json'],
  customerOwned: [
    'extensions/**',
    'sold.config.ts',
    'docs/instance/**',
    'environments/**',
    'config/**',
  ],
  generated: ['pnpm-lock.yaml', '.sold/base-version'],
};

export const CHANGELOG_1_1_0 = `# Changelog

## 1.1.0 - 2026-10-20

- [breaking] Removed the legacy cart API
- [migration][infra] Orders table gains a nullable currency column; run the migrate job before traffic shifts
- [security] Rotate the session signing key on upgrade
- Improved product page performance

## 1.0.1 - 2026-10-10

- [security] Patched a header parsing issue

## 1.0.0 - 2026-10-01

- [breaking] Initial release
`;

export interface Fixture {
  root: string;
  upstream: string;
  instance: string;
}

export function createFixture(): Fixture {
  const root = tempDir('sold-upgrade-');
  const upstream = join(root, 'upstream');
  const instance = join(root, 'instance');

  initRepo(upstream);
  writeTree(upstream, {
    '.sold/base-manifest.json': `${JSON.stringify(FIXTURE_MANIFEST, null, 2)}\n`,
    'apps/web/a.ts': 'export const a = 1;\n',
    'packages/core/index.ts': 'export const core = 1;\n',
    'packages/core/old.ts': 'export const old = 1;\n',
    'CHANGELOG.md': '# Changelog\n\n## 1.0.0 - 2026-10-01\n\n- [breaking] Initial release\n',
    'sold.config.ts': '// upstream demo config, customer-owned in instances\n',
  });
  commitAll(upstream, 'base 1.0.0');
  git(upstream, 'tag', 'base-v1.0.0');

  writeTree(upstream, { 'apps/web/a.ts': 'export const a = 1.0001;\n' });
  commitAll(upstream, 'base 1.0.1');
  git(upstream, 'tag', 'base-v1.0.1');

  writeTree(upstream, {
    'apps/web/a.ts': 'export const a = 2;\n',
    'apps/web/new.ts': 'export const fresh = true;\n',
    'upgrades/1.1.0/001-rename.ts': '// codemod: rename things\n',
    'upgrades/1.1.0/002-config.ts': '// codemod: update sold.config.ts\n',
    'CHANGELOG.md': CHANGELOG_1_1_0,
  });
  git(upstream, 'rm', '-q', 'packages/core/old.ts');
  commitAll(upstream, 'base 1.1.0');
  git(upstream, 'tag', 'base-v1.1.0');

  initRepo(instance);
  git(instance, 'remote', 'add', 'upstream', upstream);
  git(instance, 'fetch', '-q', 'upstream', '--tags');
  git(instance, 'checkout', '-q', '-B', 'main', 'base-v1.0.0');
  writeTree(instance, {
    '.sold/base-version': '1.0.0\n',
    '.sold/instance.json': `${JSON.stringify({ customer: 'demo', createdWithBaseVersion: '1.0.0' })}\n`,
    'sold.config.ts': '// the customer edited this\n',
    'extensions/loyalty/package.json': JSON.stringify({
      name: '@demo/loyalty',
      version: '1.2.0',
      sold: { requires: { base: '>=1.0.0 <2.0.0' } },
    }),
    'docs/instance/notes.md': 'customer notes\n',
  });
  commitAll(instance, 'instance setup');
  return { root, upstream, instance };
}
