import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export {
  baseInternalPackages,
  baseInternalPatterns,
  extensionBoundary,
  extensionBoundaryConfigs,
  hardDeniedPackages,
  ioBuiltins,
  pureBuiltins,
  purePackages,
} from './extension-boundary.js';

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
