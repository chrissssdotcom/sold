import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import type * as TestcontainersPostgres from '@testcontainers/postgresql';

export interface TestDatabase {
  /** Connection string for a fresh, empty database owned by this test. */
  url: string;
  name: string;
  /** Drops the database. */
  destroy(): Promise<void>;
}

/**
 * Provision a fresh, empty PostgreSQL database for a test.
 *
 * - If `SOLD_TEST_DATABASE_URL` is set (a server admin URL), a uniquely named database is created
 *   on that server. This is how CI service containers and sandboxes without Docker run.
 * - Otherwise a `postgres:16` Testcontainer is started (requires Docker).
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = process.env.SOLD_TEST_DATABASE_URL;
  if (adminUrl) return createOnServer(adminUrl);
  return createWithTestcontainers();
}

async function createOnServer(adminUrl: string): Promise<TestDatabase> {
  const name = `sold_test_${randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    name,
    async destroy() {
      const c = new Client({ connectionString: adminUrl });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}

async function createWithTestcontainers(): Promise<TestDatabase> {
  let mod: typeof TestcontainersPostgres;
  try {
    mod = await import('@testcontainers/postgresql');
  } catch (error) {
    throw new Error(
      'No test database available: set SOLD_TEST_DATABASE_URL (e.g. postgres://sold:sold@localhost:5432/postgres) or install Docker for Testcontainers.',
      { cause: error },
    );
  }
  const container = await new mod.PostgreSqlContainer('postgres:16-alpine').start();
  return {
    url: container.getConnectionUri(),
    name: container.getDatabase(),
    async destroy() {
      await container.stop();
    },
  };
}
