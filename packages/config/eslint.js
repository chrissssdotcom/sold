import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * Modules that extensions must never import (Base internals). Extensions may depend only on
 * `@sold/extension-sdk` (and third-party libraries). Every workspace package other than the SDK is off limits,
 * as is reaching into another package by path.
 */
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
];

export const baseInternalPatterns = [
  ...baseInternalPackages.flatMap((p) => [`@sold/${p}`, `@sold/${p}/*`]),
  '**/apps/**',
  '**/packages/**',
  '**/ops/**',
];

const boundaryMessage =
  'Extensions must depend only on @sold/extension-sdk, never on Base internals. If you need this, add an extension point to Base.';

/** Matches `@sold/<internal>` and `@sold/<internal>/...` in a string literal. */
const internalRegex = `^@sold\\/(${baseInternalPackages.join('|')})(\\/.*)?$`;
const pathRegex = '(^|\\/)(apps|packages|ops)\\/';

export const base = tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.terraform/**',
      '**/.generated/**',
    ],
  },
  js.configs.recommended,
  { files: ['**/*.{js,cjs,mjs}'], languageOptions: { globals: globals.node } },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
);

/** Extra rules for code under `extensions/`: no Base internals (static imports, dynamic import(), require()). */
export const extensionBoundary = {
  files: ['**/*.{ts,tsx,js,mjs,cjs}'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: baseInternalPatterns.map((group) => ({
          group: [group],
          message: boundaryMessage,
        })),
      },
    ],
    'no-restricted-syntax': [
      'error',
      ...[internalRegex, pathRegex].flatMap((re) => [
        { selector: `ImportExpression > Literal[value=/${re}/]`, message: boundaryMessage },
        {
          selector: `CallExpression[callee.name='require'] > Literal[value=/${re}/]`,
          message: boundaryMessage,
        },
        {
          selector: `TSImportType > TSLiteralType > Literal[value=/${re}/]`,
          message: boundaryMessage,
        },
      ]),
    ],
  },
};

/** `packages/core` is framework-free: no next / react. */
export const coreFrameworkFree = {
  files: ['**/*.{ts,tsx}'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['next', 'next/*', 'react', 'react/*', 'react-dom', 'react-dom/*'],
            message: '@sold/core must not import next or react.',
          },
        ],
      },
    ],
  },
};

export default base;
