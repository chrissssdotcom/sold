import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

/**
 * The extension boundary, as an ALLOWLIST (docs/extending.md "Boundaries", ADR-0004).
 *
 * Extension code is trusted, in-process code (ADR-0004): this lint is a guardrail against accidents and lazy
 * shortcuts, not a sandbox. It keeps extensions on the public SDK, keeps network/process/filesystem access out
 * of the files that run on the cart/checkout hot path, and makes every other capability an explicit,
 * reviewable choice.
 *
 * FILE-NAME CONVENTION (the lint keys off it):
 *   `*.interceptor.ts`            cart/checkout interceptors. No I/O of any kind.
 *   `*.observer.ts`               event observers (asynchronous, retried).      \
 *   `*.job.ts`                    background jobs.                               } may use I/O
 *   `*.route.ts`                  HTTP routes.                                  /
 *   `*.test.ts`, `*.spec.ts`      tests (may use I/O and `vitest`).
 *   anything else (`index.ts`, helpers, settings, blocks, slots)  is the strict tier: no I/O.
 * Keep interceptor logic in `*.interceptor.ts` files so a reviewer (and this lint) can see at a glance that it is
 * pure. Helpers imported by an interceptor are in the strict tier as well, so they cannot smuggle I/O in.
 *
 * HOW TO EXTEND
 *  - A library the extension needs: add it to that extension's own `package.json` `dependencies`. The config
 *    reads it, and it becomes importable from the I/O tier (`*.observer|job|route.ts`) of THAT extension only.
 *  - A pure library that interceptors and helpers may use too (no I/O, no globals): add it to `purePackages`
 *    below, in a reviewed change to Base.
 *  - Never allowed, even if declared as a dependency: `hardDeniedPackages` (pg, ioredis, undici, drizzle-orm, ...):
 *    use `ctx.db` / the SDK, which apply Base's pools, timeouts and budgets.
 */

/** Importable from every extension file. */
export const pureBuiltins = [
  'crypto',
  'util',
  'buffer',
  'events',
  'stream',
  'url',
  'path',
  'assert',
  'timers',
  'perf_hooks',
  'string_decoder',
  'querystring',
];

/** Importable only from `*.observer.ts`, `*.job.ts`, `*.route.ts` and tests. */
export const ioBuiltins = [
  'http',
  'https',
  'http2',
  'net',
  'tls',
  'dgram',
  'dns',
  'fs',
  'os',
  'zlib',
];

/** Never importable by extension code (no file tier is exempt). */
export const deniedBuiltins = [
  'child_process',
  'worker_threads',
  'cluster',
  'vm',
  'module',
  'inspector',
  'v8',
  'repl',
  'wasi',
  'async_hooks',
  'diagnostics_channel',
  'trace_events',
  'domain',
  'tty',
  'process',
];

/** Third-party packages importable from every extension file (must be free of I/O and of side effects). */
export const purePackages = ['@sold/extension-sdk', 'zod', 'semver', 'react', 'react/jsx-runtime'];

/** Denied even when the extension lists them in its own package.json. */
export const hardDeniedPackages = [
  'pg',
  'pg-pool',
  'pg-native',
  'postgres',
  'ioredis',
  'redis',
  'undici',
  'node-fetch',
  'drizzle-orm',
  'next',
  'react-dom',
];

/** Members of `process` extension code must not touch. */
const forbiddenProcessMembers = [
  'binding',
  'dlopen',
  'mainModule',
  'getBuiltinModule',
  '_linkedBinding',
  'kill',
  'abort',
  'reallyExit',
  'exit',
  'chdir',
  'setuid',
  'setgid',
  'on',
  'once',
  'off',
  'addListener',
  'removeListener',
  'removeAllListeners',
  'prependListener',
];

const BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, '')));
const baseOf = (specifier) => specifier.replace(/^node:/, '').split('/')[0];
const isBuiltin = (specifier) => specifier.startsWith('node:') || BUILTINS.has(baseOf(specifier));
const packageName = (specifier) =>
  specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];

const extensionRootOf = (filename) => {
  const m = /^(.*[\\/]extensions[\\/][^\\/]+)[\\/]/.exec(filename);
  return m ? m[1] : null;
};

/**
 * `sold-extension/imports`: everything an extension file may import or load, decided against the allowlist.
 * Options: { io: boolean, packages: string[], test?: boolean }.
 */
const importsRule = {
  meta: {
    type: 'problem',
    schema: [
      {
        type: 'object',
        properties: {
          io: { type: 'boolean' },
          test: { type: 'boolean' },
          packages: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: { denied: '{{message}}' },
  },
  create(context) {
    const options = context.options[0] ?? {};
    const io = options.io === true;
    const allowedPackages = new Set([...purePackages, ...(options.packages ?? [])]);
    const filename = context.filename ?? context.getFilename();
    const root = extensionRootOf(filename);
    const tier = io
      ? 'an I/O file (*.observer.ts, *.job.ts, *.route.ts)'
      : 'a strict file (I/O belongs in *.observer.ts, *.job.ts or *.route.ts)';

    const report = (node, message) =>
      context.report({ node, messageId: 'denied', data: { message } });

    function verdict(spec) {
      if (spec.startsWith('.')) {
        if (!root) return null;
        const resolved = path.resolve(path.dirname(filename), spec);
        const inside = resolved === root || resolved.startsWith(root + path.sep);
        if (!inside)
          return `"${spec}" reaches outside the extension's own directory. Extensions may only import their own files.`;
        if (resolved.split(path.sep).includes('node_modules'))
          return `"${spec}" reaches into node_modules. Import the package by name.`;
        return null;
      }
      if (path.isAbsolute(spec) || (/^[a-z][a-z0-9+.-]*:/i.test(spec) && !spec.startsWith('node:')))
        return `"${spec}": absolute paths and URLs are not importable from extension code.`;
      if (spec.startsWith('#'))
        return `"${spec}": package-internal import maps are not allowed here.`;
      if (isBuiltin(spec)) {
        const base = baseOf(spec);
        if (pureBuiltins.includes(base)) return null;
        if (deniedBuiltins.includes(base))
          return `"${spec}" is never available to extension code (process, threads and module loading belong to Base).`;
        if (ioBuiltins.includes(base)) {
          if (io || options.test) return null;
          return `"${spec}" performs I/O and is not allowed in ${tier}. Cart/checkout interceptors (*.interceptor.ts) must be pure.`;
        }
        return `"${spec}" is not on the extension allowlist for Node built-ins (allowed: ${pureBuiltins.map((m) => `node:${m}`).join(', ')}; I/O files also: ${ioBuiltins.map((m) => `node:${m}`).join(', ')}).`;
      }
      const name = packageName(spec);
      if (name.startsWith('@sold/') && name !== '@sold/extension-sdk')
        return `"${spec}" is a Base internal. Extensions must depend only on @sold/extension-sdk; if you need this, add an extension point to Base.`;
      if (hardDeniedPackages.includes(name))
        return `"${name}" is never importable by extensions, even when declared as a dependency. Use the SDK (ctx.db etc.), which applies Base's pools, timeouts and budgets.`;
      if (allowedPackages.has(name) || allowedPackages.has(spec)) return null;
      return `"${name}" is not on the extension import allowlist for ${tier}. Declare it in the extension's package.json "dependencies" (importable from I/O files) or, if it is pure, add it to purePackages in packages/config/extension-boundary.js.`;
    }

    const check = (node, spec) => {
      const message = verdict(spec);
      if (message) report(node, message);
    };
    const literalOf = (node) => {
      if (!node) return null;
      if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
      if (node.type === 'TemplateLiteral' && node.expressions.length === 0)
        return node.quasis[0].value.cooked;
      return null;
    };

    return {
      ImportDeclaration: (node) => check(node.source, node.source.value),
      ExportAllDeclaration: (node) => check(node.source, node.source.value),
      ExportNamedDeclaration: (node) => node.source && check(node.source, node.source.value),
      TSImportEqualsDeclaration(node) {
        const ref = node.moduleReference;
        if (ref.type === 'TSExternalModuleReference') {
          const spec = literalOf(ref.expression);
          if (spec === null) report(node, 'require() needs a string literal.');
          else check(node, spec);
        }
      },
      TSImportType(node) {
        const arg = node.source ?? node.argument; // `argument` is the pre-v8.4x name
        const spec = literalOf(arg) ?? literalOf(arg?.literal);
        if (spec !== null) check(node, spec);
      },
      ImportExpression(node) {
        const spec = literalOf(node.source);
        if (spec === null)
          report(node, 'import() needs a string literal: computed module names cannot be checked.');
        else check(node, spec);
      },
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
          const spec = literalOf(node.arguments[0]);
          if (spec === null)
            report(
              node,
              'require() needs a string literal: computed module names cannot be checked.',
            );
          else check(node, spec);
        }
      },
      Identifier(node) {
        const p = node.parent;
        if (!p) return;
        if (p.type === 'MemberExpression' && p.property === node && !p.computed) return;
        if (p.type === 'Property' && p.key === node && !p.computed && !p.shorthand) return;
        if (node.name === 'createRequire')
          report(node, 'createRequire() loads modules outside the allowlist and is not allowed.');
        if (node.name === 'require' && !(p.type === 'CallExpression' && p.callee === node))
          report(node, 'require may only be called directly with a string literal (no aliasing).');
      },
      MemberExpression(node) {
        const name = node.computed
          ? node.property.type === 'Literal'
            ? String(node.property.value)
            : null
          : node.property.name;
        if (
          node.object.type === 'MetaProperty' &&
          node.object.meta.name === 'import' &&
          name === 'resolve'
        )
          report(
            node,
            'import.meta.resolve() is not allowed: it resolves modules outside the allowlist.',
          );
        if (node.object.type === 'Identifier' && node.object.name === 'process' && name) {
          if (forbiddenProcessMembers.includes(name))
            report(
              node,
              `process.${name} is not available to extension code (the process belongs to Base).`,
            );
        }
        if (name === 'createRequire') report(node, 'createRequire() is not allowed.');
      },
    };
  },
};

export const extensionPlugin = { rules: { imports: importsRule } };

const NETWORK_GLOBALS = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'BroadcastChannel',
  'SharedArrayBuffer',
  'Atomics',
];

const boundaryMessage =
  'Extensions must depend only on @sold/extension-sdk, never on Base internals. If you need this, add an extension point to Base.';

/** Kept from the original boundary: explicit Base-internal bans (clear messages, and defence in depth). */
export const baseInternalPackages = [
  'core',
  'db',
  'ui',
  'identity',
  'payments',
  'testing',
  'jobs',
  'cli',
  'config',
  'commerce',
];

export const baseInternalPatterns = [
  ...baseInternalPackages.flatMap((p) => [`@sold/${p}`, `@sold/${p}/*`]),
  '**/apps/**',
  '**/packages/**',
  '**/ops/**',
];

const internalRegex = `^@sold\\/(${baseInternalPackages.join('|')})(\\/.*)?$`;
const pathRegex = '(^|\\/)(apps|packages|ops)\\/';

const baseInternalSyntax = [internalRegex, pathRegex].flatMap((re) => [
  { selector: `ImportExpression > Literal[value=/${re}/]`, message: boundaryMessage },
  {
    selector: `CallExpression[callee.name='require'] > Literal[value=/${re}/]`,
    message: boundaryMessage,
  },
  {
    selector: `TSImportType > TSLiteralType > Literal[value=/${re}/]`,
    message: boundaryMessage,
  },
]);

const globalPropertyBans = NETWORK_GLOBALS.flatMap((property) =>
  ['globalThis', 'global', 'window', 'self'].map((object) => ({
    object,
    property,
    message: `${object}.${property} performs I/O or shares memory: not allowed outside *.observer.ts, *.job.ts, *.route.ts.`,
  })),
);

/** Rules for one tier of extension files. */
function tierRules({ io, packages, test = false }) {
  return {
    'no-restricted-imports': [
      'error',
      {
        patterns: baseInternalPatterns.map((group) => ({
          group: [group],
          message: boundaryMessage,
        })),
      },
    ],
    'no-restricted-syntax': ['error', ...baseInternalSyntax],
    'sold-extension/imports': ['error', { io, packages, test }],
    'no-eval': 'error',
    'no-new-func': 'error',
    'no-implied-eval': 'off', // needs type info; `no-new-func` and `no-eval` cover the practical cases
    ...(io
      ? { 'no-restricted-globals': 'off', 'no-restricted-properties': 'off' }
      : {
          'no-restricted-globals': [
            'error',
            ...NETWORK_GLOBALS.map((name) => ({
              name,
              message: `${name} is not allowed outside *.observer.ts, *.job.ts, *.route.ts (interceptors have no I/O).`,
            })),
          ],
          'no-restricted-properties': ['error', ...globalPropertyBans],
        }),
  };
}

const ALL_FILES = '*.{ts,tsx,js,mjs,cjs}';
const IO_SUFFIXES = ['observer', 'job', 'route'];
const TEST_SUFFIXES = ['test', 'spec'];
const suffixGlob = (suffixes) => `*.{${suffixes.join(',')}}.{ts,tsx,js,mjs,cjs}`;

/**
 * The extension boundary for a repository root: one strict block for all extension code, one block for the I/O
 * files and tests, and, for each extension package, the same again with that package's own declared dependencies.
 */
export function extensionBoundaryConfigs({ root, extensionsDir = 'extensions' } = {}) {
  const configs = [
    {
      name: 'sold/extensions/strict',
      files: [`${extensionsDir}/**/${ALL_FILES}`],
      plugins: { 'sold-extension': extensionPlugin },
      rules: tierRules({ io: false, packages: [] }),
    },
    {
      name: 'sold/extensions/io',
      files: [`${extensionsDir}/**/${suffixGlob(IO_SUFFIXES)}`],
      plugins: { 'sold-extension': extensionPlugin },
      rules: tierRules({ io: true, packages: [] }),
    },
    {
      name: 'sold/extensions/tests',
      files: [`${extensionsDir}/**/${suffixGlob(TEST_SUFFIXES)}`],
      plugins: { 'sold-extension': extensionPlugin },
      rules: tierRules({ io: true, packages: ['vitest'], test: true }),
    },
  ];
  const dir = root ? path.join(root, extensionsDir) : null;
  if (!dir || !existsSync(dir)) return configs;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name === 'node_modules')
      continue;
    const pkgFile = path.join(dir, entry.name, 'package.json');
    if (!existsSync(pkgFile)) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
    } catch {
      continue; // a broken package.json is reported by `sold ext:sync`, not here
    }
    const runtime = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies });
    const dev = Object.keys(pkg.devDependencies ?? {});
    const base = `${extensionsDir}/${entry.name}`;
    configs.push(
      {
        name: `sold/extensions/${entry.name}/io`,
        files: [`${base}/**/${suffixGlob(IO_SUFFIXES)}`],
        plugins: { 'sold-extension': extensionPlugin },
        rules: tierRules({ io: true, packages: runtime }),
      },
      {
        name: `sold/extensions/${entry.name}/tests`,
        files: [`${base}/**/${suffixGlob(TEST_SUFFIXES)}`],
        plugins: { 'sold-extension': extensionPlugin },
        rules: tierRules({ io: true, packages: ['vitest', ...runtime, ...dev], test: true }),
      },
    );
  }
  return configs;
}

/** The generic (strict-tier) boundary as one config object, for callers that do not need per-package dependencies. */
export const extensionBoundary = {
  files: [`**/${ALL_FILES}`],
  plugins: { 'sold-extension': extensionPlugin },
  rules: tierRules({ io: false, packages: [] }),
};
