import { createDb } from '../client';
import { seedBase } from '../seed';
import { databaseUrls } from './env';

const { url, environment } = databaseUrls();
if (environment === 'prod') {
  console.error('Refusing to run demo seeds against prod.');
  process.exit(1);
}
const db = createDb({ primaryUrl: url, poolMax: 2 });
try {
  const result = await seedBase(db.primary);
  console.log(`seeded ${result.flags} feature flags (demo catalog seeds arrive in Phase 2)`);
} finally {
  await db.close();
}
