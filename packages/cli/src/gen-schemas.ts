import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateJsonSchemas, serializeSchema } from './schemas';

// Usage: pnpm --filter @sold/cli schemas && pnpm format   (writes .sold/schemas/*.json at the repository root, then formats them)
const root = process.env['INIT_CWD'] ?? process.cwd();
const dir = join(root, '.sold', 'schemas');
await mkdir(dir, { recursive: true });
for (const [name, schema] of Object.entries(generateJsonSchemas())) {
  await writeFile(join(dir, name), serializeSchema(schema));
  console.log(`wrote .sold/schemas/${name}`);
}
