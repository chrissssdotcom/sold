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
  cacheEvents: Counter<'result'>;
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
    cacheEvents: new Counter({
      name: 'sold_cache_events_total',
      help: 'Application cache events by result.',
      labelNames: ['result'],
      registers: [registry],
    }),
  };
}
