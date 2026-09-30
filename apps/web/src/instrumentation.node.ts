import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { drainAndClose } from './server/runtime';

/**
 * OpenTelemetry baseline: exports traces only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. The version
 * identifier is a resource attribute so any trace is tied to an exact release (Section 8C.6).
 * PENDING(phase-7): adaptive sampling that always keeps errors and slow requests.
 */
export function startTelemetry(): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (endpoint) {
    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: `sold-${process.env.SOLD_ROLE ?? 'web'}`,
        [ATTR_SERVICE_VERSION]: process.env.SOLD_VERSION ?? '0.0.0+dev.0',
        'deployment.environment.name': process.env.SOLD_ENVIRONMENT ?? 'local',
      }),
      traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
    });
    sdk.start();
    process.once('SIGTERM', () => void sdk.shutdown());
  }

  // Graceful shutdown: NEXT_MANUAL_SIG_HANDLE=true (set in the image) stops Next from exiting
  // immediately on SIGTERM, so readiness can go 503 and connections drain first.
  if (process.env.NEXT_MANUAL_SIG_HANDLE === 'true') {
    const shutdown = () => void drainAndClose().finally(() => process.exit(0));
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }
}
