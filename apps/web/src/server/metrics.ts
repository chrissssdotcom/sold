import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

export interface PoolStats {
  total: number;
  idle: number;
  waiting: number;
}

export interface Metrics {
  registry: Registry;
  httpRequests: Counter<'route_class' | 'method' | 'status_class'>;
  httpDuration: Histogram<'route_class'>;
  /** Per-extension request rate and latency (Section 8A.8: a slow extension must be visible by name). */
  extensionRequests: Counter<'extension' | 'status_class'>;
  extensionDuration: Histogram<'extension'>;
  interceptorCalls: Counter<'extension' | 'interceptor' | 'hook' | 'outcome'>;
  interceptorDuration: Histogram<'extension' | 'interceptor'>;
  safety: ExtensionSafetyMetrics;
}

export interface ExtensionSafetyMetrics {
  /** How long an interceptor held the event loop past its budget (detection, not prevention). */
  blocked: Histogram<'extension' | 'interceptor' | 'source'>;
  /** Unhandled rejections / uncaught exceptions, by the extension they were attributed to (or `unattributed`). */
  unhandled: Counter<'extension' | 'kind' | 'fatal'>;
}

/** Metrics for the hot-path and process-level guards. Shared by the web process and the worker. */
export function createExtensionSafetyMetrics(registry: Registry): ExtensionSafetyMetrics {
  return {
    blocked: new Histogram({
      name: 'sold_extension_blocked_ms',
      help: 'Time an extension interceptor blocked the event loop beyond its budget. source: sync-call (exact) or event-loop-lag (suspected). Detection only: a synchronous loop cannot be preempted.',
      labelNames: ['extension', 'interceptor', 'source'],
      buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 10000],
      registers: [registry],
    }),
    unhandled: new Counter({
      name: 'sold_extension_unhandled_failures_total',
      help: 'Unhandled promise rejections and uncaught exceptions, attributed to an extension where possible. fatal=true means the process exited.',
      labelNames: ['extension', 'kind', 'fatal'],
      registers: [registry],
    }),
  };
}

/** RED metrics per route class + pool saturation gauges (Section 8A.10). */
export function createMetrics(
  info: { version: string; environment: string; buildId: string },
  pools: () => Record<string, PoolStats>,
): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'sold_node_' });

  new Gauge({
    name: 'sold_app_info',
    help: 'Build/version info (value is always 1). Used for Grafana deploy annotations.',
    labelNames: ['version', 'environment', 'build_id'],
    registers: [registry],
  }).set({ version: info.version, environment: info.environment, build_id: info.buildId }, 1);

  const poolGauge = new Gauge({
    name: 'sold_db_pool_connections',
    help: 'Database pool connections by pool and state (total, idle, waiting). Waiting > 0 means saturation.',
    labelNames: ['pool', 'state'],
    registers: [registry],
    collect() {
      for (const [pool, s] of Object.entries(pools())) {
        poolGauge.set({ pool, state: 'total' }, s.total);
        poolGauge.set({ pool, state: 'idle' }, s.idle);
        poolGauge.set({ pool, state: 'waiting' }, s.waiting);
      }
    },
  });

  return {
    registry,
    safety: createExtensionSafetyMetrics(registry),
    httpRequests: new Counter({
      name: 'sold_http_requests_total',
      help: 'HTTP requests by route class, method and status class.',
      labelNames: ['route_class', 'method', 'status_class'],
      registers: [registry],
    }),
    httpDuration: new Histogram({
      name: 'sold_http_request_duration_seconds',
      help: 'HTTP request duration by route class.',
      labelNames: ['route_class'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.4, 0.5, 1, 1.5, 2.5, 5, 10],
      registers: [registry],
    }),
    extensionRequests: new Counter({
      name: 'sold_extension_requests_total',
      help: 'Extension route requests by extension and status class.',
      labelNames: ['extension', 'status_class'],
      registers: [registry],
    }),
    extensionDuration: new Histogram({
      name: 'sold_extension_request_duration_seconds',
      help: 'Extension route latency by extension.',
      labelNames: ['extension'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
    interceptorCalls: new Counter({
      name: 'sold_extension_interceptor_calls_total',
      help: 'Cart/checkout interceptor outcomes (ok, veto, error, timeout, violation, saturated, bypassed, invalid-modify).',
      labelNames: ['extension', 'interceptor', 'hook', 'outcome'],
      registers: [registry],
    }),
    interceptorDuration: new Histogram({
      name: 'sold_extension_interceptor_duration_ms',
      help: 'Interceptor duration in milliseconds.',
      labelNames: ['extension', 'interceptor'],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 20, 50],
      registers: [registry],
    }),
  };
}
