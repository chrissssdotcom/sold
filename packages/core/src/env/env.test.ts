import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from './index';

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/sold' };
const key = Buffer.alloc(32, 1).toString('base64');

describe('loadEnv', () => {
  it('parses minimal local env with defaults', () => {
    const env = loadEnv(base);
    expect(env.SOLD_ENVIRONMENT).toBe('local');
    expect(env.DB_POOL_MAX).toBe(10);
    expect(env.DATABASE_REPLICA_URL).toBeUndefined();
  });

  it('treats empty optional URLs as unset', () => {
    expect(loadEnv({ ...base, DATABASE_REPLICA_URL: '', REDIS_URL: '' }).REDIS_URL).toBeUndefined();
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadEnv({})).toThrow(EnvValidationError);
  });

  it('requires REDIS_URL in stage and prod', () => {
    expect(() => loadEnv({ ...base, SOLD_ENVIRONMENT: 'stage' })).toThrow(/REDIS_URL/);
    expect(() => loadEnv({ ...base, SOLD_ENVIRONMENT: 'ephemeral' })).not.toThrow();
  });

  it('requires secrets outside local in production mode', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', SOLD_ENVIRONMENT: 'dev' })).toThrow(
      /SOLD_SECRET_KEY/,
    );
    expect(() =>
      loadEnv({
        ...base,
        NODE_ENV: 'production',
        SOLD_ENVIRONMENT: 'dev',
        SOLD_SECRET_KEY: key,
        METRICS_TOKEN: 'x'.repeat(16),
        SOLD_BUILD_ID: 'abc123',
      }),
    ).not.toThrow();
  });

  it('refuses the default build id outside local in production mode', () => {
    expect(() =>
      loadEnv({
        ...base,
        NODE_ENV: 'production',
        SOLD_ENVIRONMENT: 'dev',
        SOLD_SECRET_KEY: key,
        METRICS_TOKEN: 'x'.repeat(16),
      }),
    ).toThrow(/SOLD_BUILD_ID/);
  });

  it('rejects a secret key of the wrong length', () => {
    expect(() => loadEnv({ ...base, SOLD_SECRET_KEY: Buffer.alloc(8).toString('base64') })).toThrow(
      /32 bytes/,
    );
  });

  it('never echoes values in errors', () => {
    try {
      loadEnv({ DATABASE_URL: 'not-a-url-with-secret-hunter2' });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('hunter2');
    }
  });
});
