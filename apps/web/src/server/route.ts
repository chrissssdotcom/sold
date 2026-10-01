import { resolveRequestId } from '@sold/core/observability';
import { routeClassOf, shouldShed } from '@sold/core/traffic';
import type { Logger } from '@sold/core/observability';
import { getRuntime } from './runtime';
import { currentShedBelow, isShedExempt } from './shedding';

export interface RouteContext {
  requestId: string;
  log: Logger;
}

type Handler = (request: Request, ctx: RouteContext) => Promise<Response> | Response;

/**
 * Wraps a route handler with request ID propagation, structured logging, RED metrics per route
 * class and a structured error response. Business errors should be returned as responses;
 * anything thrown here is an unexpected 500 and never leaks internals.
 */
export function route(handler: Handler): (request: Request) => Promise<Response> {
  return async (request) => {
    const rt = getRuntime();
    const url = new URL(request.url);
    const routeClass = routeClassOf(url.pathname);
    const requestId = resolveRequestId(request.headers.get('x-request-id'));
    const log = rt.log.child({ requestId, routeClass, method: request.method, path: url.pathname });
    const started = performance.now();
    let response: Response;
    try {
      // Probes and metrics never consult flags (they must answer even when the database does not).
      const shedBelow = routeClass === 'internal' ? null : await currentShedBelow();
      if (shouldShed(routeClass, shedBelow) && !isShedExempt(url.pathname)) {
        // Deliberate load shedding (Section 8A.6): cheap, explicit, and retryable. Never reached for checkout or probes.
        log.warn({ shedBelow }, 'request shed');
        response = Response.json(
          {
            error: {
              code: 'overloaded',
              message: 'Busy right now, please retry shortly',
              requestId,
            },
          },
          { status: 503, headers: { 'retry-after': '30', 'cache-control': 'no-store' } },
        );
      } else response = await handler(request, { requestId, log });
    } catch (error) {
      log.error({ err: error }, 'unhandled error in route handler');
      response = Response.json({ error: { code: 'internal_error', requestId } }, { status: 500 });
    }
    const seconds = (performance.now() - started) / 1000;
    if (routeClass !== 'internal') {
      rt.metrics.httpRequests.inc({
        route_class: routeClass,
        method: request.method,
        status_class: `${Math.floor(response.status / 100)}xx`,
      });
      rt.metrics.httpDuration.observe({ route_class: routeClass }, seconds);
      log.info({ status: response.status, durationMs: Math.round(seconds * 1000) }, 'request');
    }
    response.headers.set('x-request-id', requestId);
    return response;
  };
}
