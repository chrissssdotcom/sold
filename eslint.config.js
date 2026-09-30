import { base, extensionBoundaryConfigs, coreFrameworkFree } from '@sold/config/eslint';

export default [
  ...base,
  // Allowlist boundary for everything under extensions/ (ts, tsx, js, mjs, cjs), per file tier and per package.
  ...extensionBoundaryConfigs({ root: import.meta.dirname }),
  { ...coreFrameworkFree, files: ['packages/core/**/*.{ts,tsx}'] },
  // Scripts/config files may use console
  {
    files: ['**/scripts/**', '**/cli/**', '**/*.config.{js,ts}', 'packages/cli/**'],
    rules: { 'no-console': 'off' },
  },
];
