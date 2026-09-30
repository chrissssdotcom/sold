import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { base, extensionBoundaryConfigs } from './eslint.js';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const eslint = new ESLint({ cwd: root });

async function messages(filePath, code) {
  const [result] = await eslint.lintText(code, { filePath: resolve(root, filePath) });
  return result.messages.map((m) => m.ruleId);
}

describe('extension boundary (Section 4: isolation by lint)', () => {
  it('rejects Base internals from extensions', async () => {
    for (const source of [
      '@sold/core',
      '@sold/core/env',
      '@sold/db',
      '@sold/ui',
      '@sold/payments',
      '@sold/identity',
    ]) {
      expect(
        await messages(
          'extensions/demo/src/x.ts',
          `import x from '${source}';\nexport default x;\n`,
        ),
        source,
      ).toContain('no-restricted-imports');
    }
  });

  it('rejects every other workspace package, including jobs, cli and config', async () => {
    for (const source of [
      '@sold/jobs',
      '@sold/cli',
      '@sold/config',
      '@sold/config/eslint',
      '@sold/testing',
    ]) {
      expect(
        await messages(
          'extensions/demo/src/x.ts',
          `import x from '${source}';\nexport default x;\n`,
        ),
        source,
      ).toContain('no-restricted-imports');
    }
  });

  it('rejects dynamic import(), require() and type imports of Base internals', async () => {
    // Dynamic import() is caught by the boundary rule itself; require() and `import()` type annotations are
    // additionally banned outright by @typescript-eslint rules, so any of them rejecting is enough.
    const rejectedBy = [
      'no-restricted-syntax',
      '@typescript-eslint/no-require-imports',
      '@typescript-eslint/consistent-type-imports',
    ];
    for (const [file, code] of [
      ['x.ts', `export const f = () => import('@sold/db');\n`],
      ['x.js', `const x = require('@sold/core');\nmodule.exports = x;\n`],
      ['x.ts', `export type T = import('@sold/db').Db;\n`],
    ]) {
      const m = await messages(`extensions/demo/src/${file}`, code);
      expect(
        m.some((id) => rejectedBy.includes(id)),
        code,
      ).toBe(true);
    }
    expect(
      await messages('extensions/demo/src/x.ts', `export const f = () => import('@sold/db');\n`),
    ).toContain('no-restricted-syntax');
  });

  it('rejects reaching into Base by relative path', async () => {
    expect(
      await messages(
        'extensions/demo/src/x.ts',
        `import m from '../../../packages/db/migrations/0000_init.sql';\nexport default m;\n`,
      ),
    ).toContain('no-restricted-imports');
    expect(
      await messages(
        'extensions/demo/src/x.ts',
        `export const f = () => import('../../../apps/web/src/x');\n`,
      ),
    ).toContain('no-restricted-syntax');
  });

  it('allows relative imports inside the extension and third-party libraries', async () => {
    const m = await messages(
      'extensions/demo/src/x.ts',
      `import a from './a';\nimport b from '../b';\nimport z from 'zod';\nexport default [a, b, z];\n`,
    );
    expect(m).not.toContain('no-restricted-imports');
    expect(m).not.toContain('no-restricted-syntax');
  });

  it('allows the extension SDK', async () => {
    expect(
      await messages(
        'extensions/demo/src/x.ts',
        `import x from '@sold/extension-sdk';\nexport default x;\n`,
      ),
    ).not.toContain('no-restricted-imports');
  });

  it('does not restrict Base code importing Base packages', async () => {
    expect(
      await messages('apps/web/src/x.ts', `import x from '@sold/core';\nexport default x;\n`),
    ).not.toContain('no-restricted-imports');
  });
});

describe('core is framework-free', () => {
  it('rejects next and react in packages/core', async () => {
    expect(
      await messages(
        'packages/core/src/x.ts',
        `import React from 'react';\nexport default React;\n`,
      ),
    ).toContain('no-restricted-imports');
    expect(
      await messages('packages/core/src/x.ts', `import n from 'next/server';\nexport default n;\n`),
    ).toContain('no-restricted-imports');
  });
});

describe('extension boundary is an allowlist (review round 2)', () => {
  const ruleIds = (file, code) => messages(file, code);
  const DENIED_BY = [
    'sold-extension/imports',
    'no-restricted-imports',
    'no-restricted-syntax',
    'no-eval',
    'no-new-func',
  ];
  const denied = async (file, code) =>
    (await ruleIds(file, code)).some((id) => DENIED_BY.includes(id));

  it('rejects every package that is not on the allowlist, including ones nobody thought of', async () => {
    for (const spec of [
      'pg',
      'ioredis',
      'undici',
      'left-pad',
      'stripe',
      '@aws-sdk/client-s3',
      '@sold/brand-new-package',
    ]) {
      expect(
        await denied('extensions/demo/src/x.ts', `import x from '${spec}';\nexport default x;\n`),
        spec,
      ).toBe(true);
    }
  });

  it('rejects network, process, thread and fs modules in strict files, with or without the node: prefix', async () => {
    for (const spec of [
      'node:net',
      'net',
      'node:tls',
      'tls',
      'node:http',
      'http',
      'node:https',
      'https',
      'node:http2',
      'node:dgram',
      'dgram',
      'node:dns',
      'dns',
      'node:dns/promises',
      'node:child_process',
      'child_process',
      'node:worker_threads',
      'worker_threads',
      'node:fs',
      'fs',
      'node:fs/promises',
      'fs/promises',
      'node:vm',
      'node:module',
      'node:os',
    ]) {
      for (const file of [
        'x.ts',
        'index.ts',
        'max-quantity.interceptor.ts',
        'x.js',
        'x.mjs',
        'x.cjs',
      ]) {
        expect(
          await ruleIds(
            `extensions/demo/src/${file}`,
            `import x from '${spec}';\nexport default x;\n`,
          ),
          `${spec} in ${file}`,
        ).toContain('sold-extension/imports');
      }
    }
  });

  it('allows the pure Node built-ins and the SDK everywhere', async () => {
    for (const spec of [
      'node:crypto',
      'node:util',
      'node:buffer',
      'node:events',
      'node:stream',
      'node:url',
      'node:path',
      'node:assert',
      'node:timers',
      'node:perf_hooks',
      'crypto',
      '@sold/extension-sdk',
      'zod',
      'semver',
    ]) {
      expect(
        await ruleIds(
          'extensions/demo/src/max-quantity.interceptor.ts',
          `import x from '${spec}';\nexport default x;\n`,
        ),
        spec,
      ).not.toContain('sold-extension/imports');
    }
  });

  it('lets only *.observer.ts, *.job.ts, *.route.ts (and tests) use network and fs modules, never child_process/worker_threads', async () => {
    for (const file of ['a.observer.ts', 'a.job.ts', 'a.route.ts', 'a.observer.js', 'a.test.ts']) {
      for (const spec of ['node:https', 'node:net', 'node:fs/promises', 'node:dns']) {
        expect(
          await ruleIds(
            `extensions/demo/src/${file}`,
            `import x from '${spec}';\nexport default x;\n`,
          ),
          `${spec} in ${file}`,
        ).not.toContain('sold-extension/imports');
      }
      for (const spec of ['node:child_process', 'node:worker_threads', 'pg', 'ioredis', 'undici']) {
        expect(
          await ruleIds(
            `extensions/demo/src/${file}`,
            `import x from '${spec}';\nexport default x;\n`,
          ),
          `${spec} in ${file}`,
        ).toContain('sold-extension/imports');
      }
    }
  });

  it('bans global fetch, XMLHttpRequest and WebSocket in strict files (and only there)', async () => {
    for (const code of [
      `export const f = () => fetch('/x');\n`,
      `export const f = () => new XMLHttpRequest();\n`,
      `export const f = () => new WebSocket('wss://x');\n`,
      `export const f = () => globalThis.fetch('/x');\n`,
    ]) {
      expect(await ruleIds('extensions/demo/src/pricing.interceptor.ts', code), code).toEqual(
        expect.arrayContaining([expect.stringMatching(/no-restricted-(globals|properties)/)]),
      );
      const io = await ruleIds('extensions/demo/src/sync.observer.ts', code);
      expect(
        io.filter((id) => /no-restricted-(globals|properties)/.test(id)),
        code,
      ).toEqual([]);
    }
  });

  it('rejects require(), createRequire and computed dynamic imports that would defeat the allowlist', async () => {
    for (const [file, code] of [
      [
        'x.ts',
        `import { createRequire } from 'node:module';\nexport const r = createRequire(import.meta.url)('@sold/core');\n`,
      ],
      ['x.ts', `export const r = (globalThis as any).module.createRequire('/x')('@sold/core');\n`],
      ['x.ts', `export const f = () => import('@sold/' + 'core');\n`],
      ['x.ts', 'export const f = (n: string) => import(`@sold/${n}`);\n'],
      ['x.js', `const n = 'core';\nmodule.exports = require('@sold/' + n);\n`],
      ['x.js', `const r = require;\nmodule.exports = r('@sold/core');\n`],
      ['x.ts', `export const f = () => import.meta.resolve('@sold/core');\n`],
      ['x.mjs', `export const f = (m) => import(m);\n`],
      ['x.ts', `export const f = () => eval('1');\n`],
      ['x.ts', `export const f = () => new Function('return 1');\n`],
      ['x.ts', `export const f = () => process.binding('tcp_wrap');\n`],
      ['x.ts', `export const f = () => process.exit(1);\n`],
      ['x.ts', `export const f = () => process.getBuiltinModule('node:fs');\n`],
      ['x.ts', `export const f = () => process.on('uncaughtException', () => {});\n`],
    ]) {
      expect(await denied(`extensions/demo/src/${file}`, code), code).toBe(true);
    }
    // a literal, allowed dynamic import is fine
    expect(
      await ruleIds('extensions/demo/src/x.ts', `export const f = () => import('zod');\n`),
    ).not.toContain('sold-extension/imports');
  });

  it('rejects relative paths that leave the extension, including via node_modules', async () => {
    for (const spec of [
      '../../../node_modules/@sold/core',
      '../../../../packages/core/src/index',
      '../../other-ext/src/index',
      '../../../../etc/passwd',
      '../../node_modules/zod',
    ]) {
      expect(
        await ruleIds('extensions/demo/src/x.ts', `import x from '${spec}';\nexport default x;\n`),
        spec,
      ).toContain('sold-extension/imports');
    }
    for (const spec of ['./a', '../b', './deep/er/c', '../src/d']) {
      expect(
        await ruleIds('extensions/demo/src/x.ts', `import x from '${spec}';\nexport default x;\n`),
        spec,
      ).not.toContain('sold-extension/imports');
    }
  });

  it('applies the same rules to .js, .mjs and .cjs extension files', async () => {
    for (const file of ['x.js', 'x.mjs', 'x.cjs']) {
      expect(
        await ruleIds(`extensions/demo/src/${file}`, `import x from 'pg';\nexport default x;\n`),
        file,
      ).toContain('sold-extension/imports');
      expect(
        await ruleIds(
          `extensions/demo/src/${file}`,
          `import x from '@sold/core';\nexport default x;\n`,
        ),
        file,
      ).toContain('no-restricted-imports');
    }
    expect(
      await ruleIds(
        'extensions/demo/src/x.cjs',
        `const x = require('node:net');\nmodule.exports = x;\n`,
      ),
    ).toContain('sold-extension/imports');
  });

  it('re-exports and type imports are checked like imports', async () => {
    expect(await ruleIds('extensions/demo/src/x.ts', `export * from 'pg';\n`)).toContain(
      'sold-extension/imports',
    );
    expect(await ruleIds('extensions/demo/src/x.ts', `export { Pool } from 'pg';\n`)).toContain(
      'sold-extension/imports',
    );
    expect(
      await ruleIds(
        'extensions/demo/src/x.ts',
        `import type { Pool } from 'pg';\nexport type P = Pool;\n`,
      ),
    ).toContain('sold-extension/imports');
    expect(
      await ruleIds(
        'extensions/demo/src/x.ts',
        `import net = require('node:net');\nexport default net;\n`,
      ),
    ).toContain('sold-extension/imports');
  });
});

describe("extension boundary: per-package dependencies (from the extension's own package.json)", () => {
  async function eslintFor(pkg) {
    const dir = mkdtempSync(join(tmpdir(), 'sold-eslint-'));
    mkdirSync(join(dir, 'extensions/foo/src'), { recursive: true });
    writeFileSync(join(dir, 'extensions/foo/package.json'), JSON.stringify(pkg));
    const linter = new ESLint({
      cwd: dir,
      overrideConfigFile: true,
      overrideConfig: [...base, ...extensionBoundaryConfigs({ root: dir })],
    });
    return async (file, code) => {
      const [r] = await linter.lintText(code, { filePath: join(dir, file) });
      return r.messages.map((m) => m.ruleId);
    };
  }

  it('a declared dependency is importable from I/O files of that extension only, never from strict files', async () => {
    const lint = await eslintFor({
      dependencies: { stripe: '^1.0.0', pg: '^8' },
      devDependencies: { 'test-helper': '1' },
    });
    const code = `import s from 'stripe';\nexport default s;\n`;
    expect(await lint('extensions/foo/src/charge.observer.ts', code)).not.toContain(
      'sold-extension/imports',
    );
    expect(await lint('extensions/foo/src/charge.route.ts', code)).not.toContain(
      'sold-extension/imports',
    );
    expect(await lint('extensions/foo/src/limit.interceptor.ts', code)).toContain(
      'sold-extension/imports',
    );
    expect(await lint('extensions/foo/src/index.ts', code)).toContain('sold-extension/imports');
    expect(await lint('extensions/other/src/charge.observer.ts', code)).toContain(
      'sold-extension/imports',
    );
    // hard-denied packages stay denied even when declared
    expect(
      await lint(
        'extensions/foo/src/charge.observer.ts',
        `import pg from 'pg';\nexport default pg;\n`,
      ),
    ).toContain('sold-extension/imports');
    // dev dependencies are for tests only
    const dev = `import h from 'test-helper';\nexport default h;\n`;
    expect(await lint('extensions/foo/src/a.observer.ts', dev)).toContain('sold-extension/imports');
    expect(await lint('extensions/foo/src/a.test.ts', dev)).not.toContain('sold-extension/imports');
    expect(
      await lint(
        'extensions/foo/src/a.test.ts',
        `import { it } from 'vitest';\nit('x', () => {});\n`,
      ),
    ).not.toContain('sold-extension/imports');
  });
});

describe("the repository's own extensions pass the boundary", () => {
  it('lints extensions/ clean', async () => {
    const results = await eslint.lintFiles(['extensions/**/*.{ts,tsx,js,mjs,cjs}']);
    const problems = results.flatMap((r) =>
      r.messages.map((m) => `${r.filePath}: ${m.ruleId} ${m.message}`),
    );
    expect(problems).toEqual([]);
  });
});
