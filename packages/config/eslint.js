import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * Modules that extensions must never import (Base internals).
 * Extensions may depend only on `@sold/extension-sdk` (and third-party libs).
 */
export const baseInternalPatterns = [
  '@sold/core',
  '@sold/core/*',
  '@sold/db',
  '@sold/db/*',
  '@sold/ui',
  '@sold/ui/*',
  '@sold/identity',
  '@sold/identity/*',
  '@sold/payments',
  '@sold/payments/*',
  '@sold/testing',
  '@sold/testing/*',
  '**/apps/web/**',
  '**/packages/*/src/**',
];

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

/** Extra rules for code under `extensions/`: no Base internals. */
export const extensionBoundary = {
  files: ['**/*.{ts,tsx}'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: baseInternalPatterns.map((group) => ({
          group: [group],
          message:
            'Extensions must depend only on @sold/extension-sdk, never on Base internals. If you need this, add an extension point to Base.',
        })),
      },
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
