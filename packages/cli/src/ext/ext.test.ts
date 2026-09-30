import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { defineConfig } from '@sold/core/config';
import { discoverExtensions } from '@sold/core/extensions/discovery';
import { lintExtensionMigrationDir } from '@sold/db/lint';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanup, makeContext, tempDir } from '../testing';
import { extDocs, renderExtensionReference } from './docs';
import { extList } from './list';
import { baseRangeFor, extNew, validateExtensionName, validateTitle } from './scaffold';
import { extSync } from './sync';

const repoRoot = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const config = (extensions: unknown[]) =>
  defineConfig({
    instance: { name: 'T', customer: 'demo' },
    currencies: { base: 'AUD', enabled: [{ code: 'AUD' }] },
    locales: { default: 'en-AU', enabled: ['en-AU'] },
    extensions: extensions as never,
  });

describe('ext:new', () => {
  const setup = () => {
    const dir = tempDir();
    cpSync(join(repoRoot, 'extensions/_template'), join(dir, 'extensions/_template'), {
      recursive: true,
    });
    return dir;
  };

  it('scaffolds from the template, filling name, prefix, title and Base range', async () => {
    const dir = setup();
    try {
      const ctx = makeContext({ cwd: dir });
      const { files } = await extNew(ctx, { name: 'gift-wrap', title: 'Offer gift wrapping' });
      expect(files.sort()).toEqual([
        'extensions/gift-wrap/README.md',
        'extensions/gift-wrap/migrations/0001_init.sql',
        'extensions/gift-wrap/package.json',
        'extensions/gift-wrap/src/hello.route.ts',
        'extensions/gift-wrap/src/index.test.ts',
        'extensions/gift-wrap/src/index.ts',
        'extensions/gift-wrap/src/record-order.observer.ts',
        'extensions/gift-wrap/src/settings.ts',
        'extensions/gift-wrap/tsconfig.json',
      ]);
      const pkg = JSON.parse(readFileSync(join(dir, 'extensions/gift-wrap/package.json'), 'utf8'));
      expect(pkg).toMatchObject({
        name: '@sold-ext/gift-wrap',
        description: 'Offer gift wrapping',
        sold: { requires: { base: '^0.1.0' } },
      });
      const index = readFileSync(join(dir, 'extensions/gift-wrap/src/index.ts'), 'utf8');
      expect(index).toContain("name: 'gift-wrap'");
      const observer = readFileSync(
        join(dir, 'extensions/gift-wrap/src/record-order.observer.ts'),
        'utf8',
      );
      expect(observer).toContain('INSERT INTO ext_gift_wrap_events');
      expect(
        readFileSync(join(dir, 'extensions/gift-wrap/migrations/0001_init.sql'), 'utf8'),
      ).toContain('CREATE TABLE ext_gift_wrap_events');
      expect(JSON.stringify([...files.map((f) => readFileSync(join(dir, f), 'utf8'))])).not.toMatch(
        /__[A-Z_]+__/,
      );
      expect(ctx.out.lines.join('\n')).toMatch(
        /pnpm install[\s\S]*sold\.config\.ts[\s\S]*ext:sync/,
      );
    } finally {
      cleanup(dir);
    }
  });

  it('refuses invalid, reserved and existing names, and writes nothing on --dry-run', async () => {
    const dir = setup();
    try {
      const ctx = makeContext({ cwd: dir });
      await expect(extNew(ctx, { name: 'Bad Name' })).rejects.toThrow(/invalid extension name/);
      await expect(extNew(ctx, { name: 'admin' })).rejects.toThrow(/reserved/);
      await extNew(makeContext({ cwd: dir, dryRun: true }), { name: 'wrapper' });
      expect(existsSync(join(dir, 'extensions/wrapper'))).toBe(false);
      await extNew(ctx, { name: 'wrapper' });
      await expect(extNew(ctx, { name: 'wrapper' })).rejects.toThrow(/already exists/);
    } finally {
      cleanup(dir);
    }
  });

  it('a hostile --title cannot inject a JSON key or TypeScript code', async () => {
    const dir = setup();
    try {
      const ctx = makeContext({ cwd: dir });
      const jsonAttack =
        'x", "scripts": {"postinstall": "id"}, "pnpm": {"onlyBuiltDependencies": ["evil"]}, "y": "';
      await extNew(ctx, { name: 'demo-a', title: jsonAttack });
      const pkg = JSON.parse(readFileSync(join(dir, 'extensions/demo-a/package.json'), 'utf8'));
      expect(pkg.description).toBe(jsonAttack); // stored as text, not parsed as JSON
      expect(pkg.pnpm).toBeUndefined();
      expect(Object.keys(pkg.scripts)).toEqual(['typecheck', 'lint', 'test']); // the template's, untouched

      const tsAttack = `x'; (await import('node:child_process')).execSync('id'); const _='  back\\slash "dq"`;
      await extNew(ctx, { name: 'demo-b', title: tsAttack });
      const source = readFileSync(join(dir, 'extensions/demo-b/src/index.ts'), 'utf8');
      const file = ts.createSourceFile('index.ts', source, ts.ScriptTarget.ES2022, true);
      expect(ts.transpileModule(source, { reportDiagnostics: true }).diagnostics).toEqual([]);
      // Nothing but the template's own statements: imports and the default export.
      expect(
        file.statements
          .map((st) => ts.SyntaxKind[st.kind])
          .filter((k) => k !== 'ImportDeclaration'),
      ).toEqual(['ExportAssignment']);
      let description: string | undefined;
      const visit = (n: ts.Node): void => {
        if (
          ts.isPropertyAssignment(n) &&
          ts.isIdentifier(n.name) &&
          n.name.text === 'description' &&
          ts.isStringLiteral(n.initializer)
        )
          description ??= n.initializer.text; // the manifest's own, first in the file
        ts.forEachChild(n, visit);
      };
      visit(file);
      expect(description).toBe(tsAttack);
      // and the README carries it as plain text
      expect(readFileSync(join(dir, 'extensions/demo-b/README.md'), 'utf8')).toContain(tsAttack);
    } finally {
      cleanup(dir);
    }
  });

  it('rejects titles that are empty, too long, or contain control/line-break/bidi characters', async () => {
    for (const bad of [
      '',
      '   ',
      'x'.repeat(201),
      'a\nb',
      'a\rb',
      'a\u0000b',
      'a\u202Eb',
      'a\u2028b',
      'a\u200Bb',
    ])
      expect(() => validateTitle(bad), JSON.stringify(bad)).toThrow(/invalid --title/);
    expect(() => validateTitle('Offer gift wrapping (v2) — "fast"')).not.toThrow();
    const dir = setup();
    try {
      await expect(
        extNew(makeContext({ cwd: dir }), { name: 'demo-c', title: 'a\nb' }),
      ).rejects.toThrow(/invalid --title/);
      expect(existsSync(join(dir, 'extensions/demo-c'))).toBe(false); // nothing half-written
    } finally {
      cleanup(dir);
    }
  });

  it('maps Base versions to compatibility ranges', () => {
    expect(baseRangeFor('0.1.7')).toBe('^0.1.0');
    expect(baseRangeFor('1.8.2')).toBe('^1.0.0');
    expect(() => validateExtensionName('ok-name')).not.toThrow();
  });
});

describe('a freshly scaffolded extension actually works', () => {
  const name = 'zz-scaffold-check';
  const target = join(repoRoot, 'extensions', name);
  afterAll(() => rmSync(target, { recursive: true, force: true }));

  it('loads, lints, passes its own test and type-checks', async () => {
    rmSync(target, { recursive: true, force: true });
    await extNew(makeContext({ cwd: repoRoot }), { name });
    // `pnpm install` would link its dependencies; the test borrows the example's identical set.
    symlinkSync(
      join(repoRoot, 'extensions/loyalty-points/node_modules'),
      join(target, 'node_modules'),
      'dir',
    );

    // 1. It is a valid manifest that discovery accepts (name, requires mirror, migrations).
    const found = await discoverExtensions(repoRoot, async () => config([name]));
    expect(found.extensions[0]).toMatchObject({
      name,
      origin: 'instance',
      migrationFiles: ['0001_init.sql'],
    });
    expect(found.extensions[0]?.manifest.observers.map((o) => o.name)).toEqual(['record-order']);

    // 2. Its migration passes the extension namespace and online-safety linter.
    const reports = await lintExtensionMigrationDir(join(target, 'migrations'), name);
    expect(reports.flatMap((r) => r.findings)).toEqual([]);

    // 3. Its own unit test passes.
    const vitest = join(repoRoot, 'extensions/loyalty-points/node_modules/vitest/vitest.mjs');
    execFileSync(process.execPath, [vitest, 'run'], {
      cwd: target,
      stdio: 'pipe',
      timeout: 60_000,
    });

    // 4. It type-checks against the SDK.
    execFileSync(
      process.execPath,
      [join(repoRoot, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', '.'],
      { cwd: target, stdio: 'pipe', timeout: 60_000 },
    );
  }, 120_000);
});

describe('ext:sync, ext:list, ext:docs (real repository)', () => {
  it('writes a registry that imports exactly the configured extensions', async () => {
    const rel = 'apps/web/.generated/extensions.sync-test.ts';
    try {
      const r = await extSync(makeContext({ cwd: repoRoot }), {
        out: rel,
        loadConfig: async () => config(['loyalty-points']),
      });
      expect(r.extensions).toEqual(['loyalty-points']);
      const src = readFileSync(join(repoRoot, rel), 'utf8');
      expect(src).toContain(
        "import ext_loyalty_points from '../../../extensions/loyalty-points/src/index';",
      );
    } finally {
      rmSync(join(repoRoot, rel), { force: true });
    }
  });

  it('--dry-run writes nothing', async () => {
    const ctx = makeContext({ cwd: repoRoot, dryRun: true });
    await extSync(ctx, {
      out: 'apps/web/.generated/never-written.ts',
      loadConfig: async () => config(['loyalty-points']),
    });
    expect(existsSync(join(repoRoot, 'apps/web/.generated/never-written.ts'))).toBe(false);
    expect(ctx.out.lines.join()).toMatch(/would write/);
  });

  it('ext:list shows the load order for the demo config', async () => {
    const ctx = makeContext({ cwd: repoRoot });
    await extList(ctx);
    expect(ctx.out.lines.join('\n')).toMatch(
      /1 extension\(s\) load in this order:[\s\S]*1\. loyalty-points@1\.0\.0 \[first-party\] \(hot path\)/,
    );
  });

  it('ext:docs renders every contribution type from the manifest', async () => {
    const found = await discoverExtensions(repoRoot, async () => config(['loyalty-points']));
    const doc = renderExtensionReference(found.extensions[0]!);
    for (const expected of [
      '## loyalty-points',
      '`^0.1.0`',
      'yes (budget 10 ms per call)',
      '`ext_loyalty_points_`',
      '`0001_init.sql`',
      '`crmApiToken`',
      'yes (encrypted)',
      '`loyalty-points.accounts.adjust`',
      '`order.placed`',
      '`award-points`',
      '`cart.item.adding`',
      'fail open',
      '`/x/loyalty-points/balance/:customerId`',
      '`pricing.rounding`',
      '`charm-pricing`',
      '`ext.loyalty-points.expire`',
      '`0 3 * * *`',
      '`reporting.ext_loyalty_points_balances`',
    ]) {
      expect(doc, expected).toContain(expected);
    }
  });

  it('ext:docs handles zero extensions and writes to the requested path', async () => {
    const out = 'apps/web/.generated/ext-docs-test.md';
    try {
      const body = await extDocs(makeContext({ cwd: repoRoot }), {
        out,
        loadConfig: async () => config([]),
      });
      expect(body).toContain('No extensions are configured.');
      expect(readFileSync(join(repoRoot, out), 'utf8')).toBe(body);
    } finally {
      rmSync(join(repoRoot, out), { force: true });
    }
  });
});

describe('ext:migrate', () => {
  it('reports migrations and lifecycle changes from the kernel (fake factory)', async () => {
    const { extMigrate } = await import('./migrate');
    const kernel = {
      migrate: async () => [{ extension: 'loyalty-points', applied: ['0001_init.sql'] }],
      reconcile: async () => ({
        installed: ['loyalty-points'],
        enabled: [],
        disabled: [],
        unchanged: [],
      }),
    };
    let closed = false;
    const ctx = makeContext({ cwd: repoRoot });
    await extMigrate(ctx, async () => ({
      kernel: kernel as never,
      close: async () => void (closed = true),
    }));
    expect(ctx.out.lines).toEqual([
      'loyalty-points: applied 0001_init.sql',
      'extensions: installed: loyalty-points',
    ]);
    expect(closed).toBe(true);
  });

  it('--dry-run touches nothing', async () => {
    const { extMigrate } = await import('./migrate');
    const ctx = makeContext({ cwd: repoRoot, dryRun: true });
    await extMigrate(ctx, async () => {
      throw new Error('must not be called');
    });
    expect(ctx.out.lines.join()).toMatch(/would migrate loyalty-points: 0001_init\.sql/);
  });
});
