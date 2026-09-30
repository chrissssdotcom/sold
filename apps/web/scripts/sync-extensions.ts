// Generates `.generated/extensions.ts`: a static registry of the extensions configured in `sold.config.ts`.
// Run before dev/build/typecheck/test (see package.json). Bundlers cannot follow dynamic imports, so extensions
// are imported statically, and only the ones that are configured.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverExtensions,
  DiscoveryError,
  renderRegistryModule,
} from '@sold/core/extensions/discovery';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(webRoot, '../..');
const out = resolve(webRoot, '.generated/extensions.ts');

try {
  const result = await discoverExtensions(repoRoot);
  for (const w of result.warnings) console.warn(`warning: ${w}`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, renderRegistryModule(result, out));
  console.log(
    `extensions: ${result.extensions.length === 0 ? 'none' : result.extensions.map((e) => e.name).join(', ')}`,
  );
} catch (error) {
  console.error(error instanceof DiscoveryError ? error.message : error);
  process.exit(1);
}
