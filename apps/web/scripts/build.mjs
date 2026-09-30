// Bundles the two runtime artifacts that Next does not build for us into self-contained CJS files:
//  - the shared cache handler (Next `require`s it by path)
//  - the worker entrypoint (a separate deployable from the same codebase, Section 8A.3)
import { build } from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: false,
  logLevel: 'warning',
  // `debug` (pulled in by ioredis) optionally requires this; bundlers flag it as unresolvable.
  alias: { 'supports-color': './scripts/empty-module.cjs' },
  // Optional native driver of pg; never present.
  external: ['pg-native'],
};

await build({
  ...shared,
  entryPoints: ['src/cache/handler.ts'],
  outfile: '.generated/cache-handler.cjs',
});
await build({
  ...shared,
  entryPoints: ['worker/main.ts'],
  outfile: '.generated/worker.cjs',
  banner: { js: '' },
});
