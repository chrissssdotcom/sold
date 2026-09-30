// Bundles the TypeScript cache handler into a single CJS file Next can `require` at runtime.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/cache/handler.ts'],
  outfile: '.generated/cache-handler.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: false,
  // `debug` (pulled in by ioredis) optionally requires this; bundlers flag it as unresolvable.
  alias: { 'supports-color': './scripts/empty-module.cjs' },
  logLevel: 'warning',
});
