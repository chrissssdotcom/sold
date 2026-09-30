import { base, extensionBoundary, coreFrameworkFree } from '@sold/config/eslint';

export default [
  ...base,
  { ...extensionBoundary, files: ['extensions/**/*.{ts,tsx}'] },
  { ...coreFrameworkFree, files: ['packages/core/**/*.{ts,tsx}'] },
  // Scripts/config files may use console
  {
    files: ['**/scripts/**', '**/cli/**', '**/*.config.{js,ts}', 'packages/cli/**'],
    rules: { 'no-console': 'off' },
  },
];
