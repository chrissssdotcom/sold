import { z } from 'zod';
import { environmentNames } from '../config/schema';

const url = z.string().url();
const optionalUrl = z
  .string()
  .optional()
  .transform((v) => (v === '' ? undefined : v))
  .pipe(url.optional());

/**
 * Typed, validated process environment (12-factor). Validated once at boot.
 * Secrets only ever come from here (or a secrets manager that populates it), never from git.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    SOLD_ENVIRONMENT: z.enum(environmentNames).default('local'),
    SOLD_ROLE: z.enum(['web', 'worker']).default('web'),
    SOLD_SCALE_MODE: z.enum(['normal', 'prescale']).default('normal'),
    /** `<base-version>+<customer>.<instance-build>` (Section 8C.6). */
    SOLD_VERSION: z.string().default('0.0.0+dev.0'),
    /** Identifies the build (git SHA); namespaces the shared cache so rolling deploys never mix builds. */
    SOLD_BUILD_ID: z.string().default('dev'),
    /** Seconds to keep serving (readiness=false) after SIGTERM so load balancers can drain. */
    SOLD_DRAIN_SECONDS: z.coerce.number().int().min(0).max(120).default(10),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    /** Primary (writes, read-your-writes). Point at PgBouncer in deployed environments. */
    DATABASE_URL: url,
    /** Optional read replica handle. Falls back to the primary when unset. */
    DATABASE_REPLICA_URL: optionalUrl,
    /** Direct (non-pooled) URL used by migrations, which need session semantics. */
    DATABASE_MIGRATION_URL: optionalUrl,
    /** `pgbouncer` = transaction pooling: timeouts come from database-level defaults, not startup params. */
    DATABASE_POOLER: z.enum(['none', 'pgbouncer']).default('none'),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),
    DB_LOCK_TIMEOUT_MS: z.coerce.number().int().min(100).default(2_000),
    DB_IDLE_IN_TX_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),

    /** Shared cache handler / rate limits / hot-SKU counters. Optional in local/ephemeral/dev. */
    REDIS_URL: optionalUrl,

    /** Base64 32-byte key encrypting stored credentials (envelope encryption root in dev). */
    SOLD_SECRET_KEY: z.string().optional(),
    /** Bearer token protecting `/metrics`. */
    METRICS_TOKEN: z.string().min(16).optional(),
    OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl,
  })
  .superRefine((env, ctx) => {
    const shared = env.SOLD_ENVIRONMENT === 'stage' || env.SOLD_ENVIRONMENT === 'prod';
    if (shared && !env.REDIS_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['REDIS_URL'],
        message: 'REDIS_URL is required in stage and prod (shared cache, rate limits, counters)',
      });
    }
    if (env.SOLD_ENVIRONMENT !== 'local' && env.NODE_ENV === 'production') {
      if (!env.SOLD_SECRET_KEY) {
        ctx.addIssue({
          code: 'custom',
          path: ['SOLD_SECRET_KEY'],
          message: 'SOLD_SECRET_KEY is required outside local',
        });
      }
      if (!env.METRICS_TOKEN) {
        ctx.addIssue({
          code: 'custom',
          path: ['METRICS_TOKEN'],
          message: 'METRICS_TOKEN is required outside local',
        });
      }
    }
    if (
      env.NODE_ENV === 'production' &&
      env.SOLD_ENVIRONMENT !== 'local' &&
      env.SOLD_BUILD_ID === 'dev'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['SOLD_BUILD_ID'],
        message:
          'SOLD_BUILD_ID must identify the build (git SHA) outside local: builds sharing "dev" would share a cache namespace',
      });
    }
    if (env.SOLD_SECRET_KEY && Buffer.from(env.SOLD_SECRET_KEY, 'base64').length !== 32) {
      ctx.addIssue({
        code: 'custom',
        path: ['SOLD_SECRET_KEY'],
        message: 'SOLD_SECRET_KEY must be 32 bytes, base64 encoded',
      });
    }
  });

export type Env = z.output<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    // Report variable names and messages only; never echo values (they may be secrets).
    throw new EnvValidationError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return parsed.data;
}
