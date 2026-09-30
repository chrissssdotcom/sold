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
