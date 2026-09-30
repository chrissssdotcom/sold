import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

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
