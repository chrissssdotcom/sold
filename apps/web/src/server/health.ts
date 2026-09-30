import { withTimeout } from '@sold/core/resilience';

export type CheckStatus = 'up' | 'down' | 'skipped';
export interface CheckResult {
  status: CheckStatus;
  latencyMs: number;
  error?: string;
}
export type Readiness = 'ok' | 'degraded' | 'unavailable';

export interface HealthDeps {
  isDraining(): boolean;
  /** Required: without the primary DB the instance cannot serve dynamic traffic. */
  checkPrimary(): Promise<void>;
  /** Optional dependencies degrade the instance but never fail readiness. */
  checkReplica?: () => Promise<void>;
  checkRedis?: () => Promise<void>;
  /**
   * Extension kernel booted (load order valid, migrations applied). REQUIRED to serve: a release whose extensions
   * cannot boot must never take traffic, so a rolling deploy keeps the previous revision.
   */
  checkExtensions?: () => Promise<void>;
  timeoutMs?: number;
}

async function run(
  name: string,
  fn: (() => Promise<void>) | undefined,
  timeoutMs: number,
): Promise<CheckResult> {
  if (!fn) return { status: 'skipped', latencyMs: 0 };
  const started = performance.now();
  try {
    await withTimeout(fn(), timeoutMs, name);
    return { status: 'up', latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    // Report the failure class only: connection errors can embed hostnames or credentials.
    return {
      status: 'down',
      latencyMs: Math.round(performance.now() - started),
      error: (error as Error).name,
    };
  }
}

/**
 * Readiness (Section 8A.3): 503 only when this instance should be taken out of rotation
 * (draining, or primary DB unreachable). Replica/Redis loss degrades but keeps serving, because
 * the cache fails open and reads fall back to the primary.
 */
export async function evaluateReadiness(deps: HealthDeps): Promise<{
  status: Readiness;
  draining: boolean;
  checks: Record<string, CheckResult>;
}> {
  const timeoutMs = deps.timeoutMs ?? 1_500;
  const draining = deps.isDraining();
  const [primary, replica, redis, extensions] = await Promise.all([
    run('primary', deps.checkPrimary, timeoutMs),
    run('replica', deps.checkReplica, timeoutMs),
    run('redis', deps.checkRedis, timeoutMs),
    run('extensions', deps.checkExtensions, Math.max(timeoutMs, 30_000)),
  ]);
  const checks = { primary, replica, redis, extensions };
  let status: Readiness = 'ok';
  if (replica.status === 'down' || redis.status === 'down') status = 'degraded';
  if (primary.status === 'down' || extensions.status === 'down' || draining) status = 'unavailable';
  return { status, draining, checks };
}

type ReadinessResult = Awaited<ReturnType<typeof evaluateReadiness>>;

/**
 * Wraps `evaluateReadiness` so a public, unauthenticated endpoint cannot be used to load the database:
 * dependency checks run at most once per `ttlMs`, concurrent callers share the in-flight check, and a
 * failure is cached briefly too (so a struggling primary is not hammered by probes). Draining is always
 * evaluated live, so a SIGTERM takes effect immediately.
 */
export function cachedReadiness(
  deps: HealthDeps,
  ttlMs = 1_000,
  now: () => number = Date.now,
): () => Promise<ReadinessResult> {
  let cached: { at: number; result: ReadinessResult } | undefined;
  let inFlight: Promise<ReadinessResult> | undefined;
  return async () => {
    if (deps.isDraining())
      return evaluateReadiness({
        ...deps,
        checkPrimary: async () => undefined,
        checkReplica: undefined,
        checkRedis: undefined,
      });
    if (cached && now() - cached.at < ttlMs) return cached.result;
    inFlight ??= evaluateReadiness(deps)
      .then((result) => {
        cached = { at: now(), result };
        return result;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}
