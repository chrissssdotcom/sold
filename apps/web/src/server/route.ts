import { resolveRequestId } from '@sold/core/observability';
import { routeClassOf } from '@sold/core/traffic';
import type { Logger } from '@sold/core/observability';
import { getRuntime } from './runtime';

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
      response = await handler(request, { requestId, log });
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
