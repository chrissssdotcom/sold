import { loadEnv } from '@sold/core/env';
import { createDb } from '../client';
import { seedBase } from '../seed';

const env = loadEnv();
if (env.SOLD_ENVIRONMENT === 'prod') {
  console.error('Refusing to run demo seeds against prod.');
  process.exit(1);
}
const db = createDb({ primaryUrl: env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL, poolMax: 2 });
try {
  const result = await seedBase(db.primary);
  console.log(`seeded ${result.flags} feature flags (demo catalog seeds arrive in Phase 2)`);
} finally {
  await db.close();
}
