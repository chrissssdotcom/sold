import { z } from 'zod';
import { environmentNames, type EnvironmentName } from '../config/schema';

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
    /**
     * Which environment this is. Defaults to `local` ONLY outside production builds: with NODE_ENV=production it must
     * be stated (see `superRefine`), otherwise a production host missing the variable would silently use local
     * defaults, including the public development encryption key.
     */
    SOLD_ENVIRONMENT: z.enum(environmentNames).optional(),
    SOLD_ROLE: z.enum(['web', 'worker']).default('web'),
    SOLD_SCALE_MODE: z.enum(['normal', 'prescale']).default('normal'),
    /** `<base-version>+<customer>.<instance-build>` (Section 8C.6). */
    SOLD_VERSION: z.string().default('0.0.0+dev.0'),
    /** Identifies the build (git SHA); namespaces the shared cache so rolling deploys never mix builds. */
    SOLD_BUILD_ID: z.string().default('dev'),
    /** Seconds to keep serving (readiness=false) after SIGTERM so load balancers can drain. */
    SOLD_DRAIN_SECONDS: z.coerce.number().int().min(0).max(120).default(10),
    /** Hard ceiling for one extension route handler (`/x/<ext>/...`). */
    SOLD_EXTENSION_ROUTE_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(10_000),
    /** Largest request body an extension route will accept (by Content-Length). */
    SOLD_EXTENSION_MAX_BODY_BYTES: z.coerce.number().int().min(1_024).default(1_048_576),
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
    /**
     * Comma-separated base64 32-byte keys that were `SOLD_SECRET_KEY` before a rotation. They can only DECRYPT; new
     * writes and `ext:settings:rotate` use the current key. Remove them once `rotate` reports nothing left.
     */
    SOLD_SECRET_KEY_PREVIOUS: z.string().optional(),

    /**
     * Extension database isolation (ADR-0004). `enforce`: each extension's `ctx.db` connects as its own least-privilege
     * database role. `off`: extensions share the application's privileges; local development and tests only.
     * Default: `enforce` in production builds and in every environment except `local`, else `off`.
     */
    SOLD_EXTENSION_DB_ISOLATION: z.enum(['enforce', 'off']).optional(),
    /**
     * Host/port/database used for extension connections (credentials in it are ignored). Point it at the pooler in
     * deployed environments; defaults to `DATABASE_URL`.
     */
    DATABASE_EXTENSION_URL: optionalUrl,
    /**
     * Secret the per-extension database role passwords are derived from. Required (by `createKernel`) when isolation is
     * `enforce` and at least one extension is enabled: an instance without extensions needs none.
     */
    SOLD_EXTENSION_DB_SECRET: z.string().min(32).optional(),
    /** Maximum connections per extension (and per handle). The total budget is extensions x this; idle pools hold none. */
    SOLD_EXTENSION_DB_POOL_MAX: z.coerce.number().int().min(1).max(20).default(3),
    /** Prefix of the extension roles (`<prefix><name>`). Roles are cluster-wide: deployments sharing a cluster differ here. */
    SOLD_EXTENSION_DB_ROLE_PREFIX: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,24}$/, 'lower-case letters, digits and underscores')
      .default('sold_ext_'),
    /** Bearer token protecting `/metrics`. */
    METRICS_TOKEN: z.string().min(16).optional(),
    /** Trust `X-Forwarded-For`/`CF-Connecting-IP` for the client address (set only behind a proxy that overwrites them). */
    SOLD_TRUST_PROXY: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),
    /** Card payments via Stripe. Both must be set to enable the gateway. */
    STRIPE_SECRET_KEY: z.string().min(8).optional(),
    STRIPE_WEBHOOK_SECRET: z.string().min(8).optional(),
    OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl,
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.SOLD_ENVIRONMENT === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['SOLD_ENVIRONMENT'],
        message:
          'SOLD_ENVIRONMENT must be set explicitly when NODE_ENV=production (local | ephemeral | dev | stage | prod): defaulting to local would use the public development encryption key',
      });
    }
    const environment = env.SOLD_ENVIRONMENT ?? 'local';
    const shared = environment === 'stage' || environment === 'prod';
    if (shared && !env.REDIS_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['REDIS_URL'],
        message: 'REDIS_URL is required in stage and prod (shared cache, rate limits, counters)',
      });
    }
    if (environment !== 'local' && env.NODE_ENV === 'production') {
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
    if (env.NODE_ENV === 'production' && environment !== 'local' && env.SOLD_BUILD_ID === 'dev') {
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
    for (const previous of splitKeys(env.SOLD_SECRET_KEY_PREVIOUS)) {
      if (Buffer.from(previous, 'base64').length !== 32) {
        ctx.addIssue({
          code: 'custom',
          path: ['SOLD_SECRET_KEY_PREVIOUS'],
          message: 'every SOLD_SECRET_KEY_PREVIOUS entry must be 32 bytes, base64 encoded',
        });
        break;
      }
    }
    if (env.SOLD_SECRET_KEY_PREVIOUS && !env.SOLD_SECRET_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['SOLD_SECRET_KEY_PREVIOUS'],
        message: 'SOLD_SECRET_KEY_PREVIOUS needs a current SOLD_SECRET_KEY',
      });
    }
    const strict = env.NODE_ENV === 'production' || environment !== 'local';
    if (env.SOLD_EXTENSION_DB_ISOLATION === 'off' && strict) {
      ctx.addIssue({
        code: 'custom',
        path: ['SOLD_EXTENSION_DB_ISOLATION'],
        message:
          'SOLD_EXTENSION_DB_ISOLATION=off is for local development and tests only: it is refused in production builds and in every environment except local',
      });
    }
  });

type RawEnv = z.output<typeof envSchema>;
/** The validated environment; `SOLD_ENVIRONMENT` is always resolved (an explicit value, or `local` outside production). */
export type Env = Omit<RawEnv, 'SOLD_ENVIRONMENT'> & { SOLD_ENVIRONMENT: EnvironmentName };

/** The effective isolation mode: explicit setting, else `enforce` in production builds and outside local. */
export function extensionDbIsolation(
  env: Pick<
    z.input<typeof envSchema>,
    'NODE_ENV' | 'SOLD_ENVIRONMENT' | 'SOLD_EXTENSION_DB_ISOLATION'
  >,
): 'enforce' | 'off' {
  if (env.SOLD_EXTENSION_DB_ISOLATION) return env.SOLD_EXTENSION_DB_ISOLATION;
  const environment: EnvironmentName = env.SOLD_ENVIRONMENT ?? 'local';
  return env.NODE_ENV === 'production' || environment !== 'local' ? 'enforce' : 'off';
}

/** Comma-separated key list to its entries (whitespace and empty entries dropped). */
export function splitKeys(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

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
  return { ...parsed.data, SOLD_ENVIRONMENT: parsed.data.SOLD_ENVIRONMENT ?? 'local' };
}
