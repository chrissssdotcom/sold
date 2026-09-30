import { fileURLToPath } from 'node:url';
import { loadEnv } from '@sold/core/env';
import { migrate } from '../migrate';

const env = loadEnv();
const url = env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL;
const dir = fileURLToPath(new URL('../../migrations', import.meta.url));

const result = await migrate({ url, dir, onLog: (m) => console.log(m) });
console.log(`migrations: ${result.applied.length} applied, ${result.skipped.length} up to date`);
