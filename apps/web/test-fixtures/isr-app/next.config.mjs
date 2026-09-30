import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Test fixture: a minimal Next app wired to the SAME cache handler bundle the real app uses, so tests exercise
// real Next ISR behaviour (page tags, revalidatePath, revalidateTag) rather than synthetic handler calls.
const handler = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../.generated/cache-handler.cjs',
);
if (!existsSync(handler)) throw new Error('Build the handler first: node scripts/build.mjs');

export default {
  cacheHandler: handler,
  cacheMaxMemorySize: 0,
  generateBuildId: async () => process.env.SOLD_BUILD_ID ?? 'e2e',
  poweredByHeader: false,
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};
