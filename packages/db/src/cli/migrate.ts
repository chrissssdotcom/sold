import { fileURLToPath } from 'node:url';
import { migrate } from '../migrate';
import { databaseUrls } from './env';

const { url } = databaseUrls();
const dir = fileURLToPath(new URL('../../migrations', import.meta.url));

const result = await migrate({ url, dir, onLog: (m) => console.log(m) });
console.log(`migrations: ${result.applied.length} applied, ${result.skipped.length} up to date`);
