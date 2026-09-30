import { withTimeout, TimeoutError } from '@sold/core/resilience';
import { ForbiddenError, type Kernel, type Authorizer } from '@sold/core/extensions';
import type { Actor, RouteContext } from '@sold/extension-sdk';
import type { Logger } from '@sold/core/observability';

export interface ExtensionHttpDeps {
  kernel: Pick<Kernel, 'routes' | 'authorizer' | 'contextFor'>;
  log: Pick<Logger, 'error' | 'warn' | 'child'>;
  timeoutMs: number;
  maxBodyBytes: number;
  /** Resolve who is calling. `null` until sessions and API keys exist (Phase 5); non-public routes then fail closed. */
  resolveActor?(request: Request): Promise<Actor | null>;
  onResult?(result: { extension: string; status: number; seconds: number }): void;
}

const json = (
  status: number,
  code: string,
  requestId: string,
  extra: Record<string, unknown> = {},
  headers: HeadersInit = {},
) =>
  Response.json(
    { error: { code, requestId, ...extra } },
    { status, headers: { 'cache-control': 'no-store', ...headers } },
  );

/**
 * Serves `/x/<extension>/...` and `/admin/x/<extension>/...`: the ONLY door through which extension code handles
 * an HTTP request. Guarantees, whatever the extension does:
 *  - routes are mounted under a reserved prefix, so they cannot shadow Base routes;
 *  - permission is checked through the single `authorize()` primitive before the handler runs; a route is either
 *    explicitly `public` or permissioned, and with no actor resolver non-public routes are denied (fail closed);
 *  - oversized bodies are rejected up front, and the handler has a hard time limit;
 *  - a thrown error, a timeout or a malformed return value becomes a structured error carrying the request ID,
 *    is logged with the extension name, and never reaches the shopper as a stack trace;
 *  - responses default to `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`, so a personalised
 *    extension response can never be stored by the CDN unless the extension deliberately says otherwise.
 */
export async function handleExtensionRequest(
  deps: ExtensionHttpDeps,
  request: Request,
  requestId: string,
): Promise<Response> {
  const started = performance.now();
  const url = new URL(request.url);
  const match = deps.kernel.routes.match(request.method, url.pathname);
  if (match.status === 'not-found') return json(404, 'not_found', requestId);
  if (match.status === 'method-not-allowed')
    return json(405, 'method_not_allowed', requestId, {}, { allow: match.allowed.join(', ') });

  const { mounted, params } = match;
  const extension = mounted.extension;
  const log = deps.log.child({
    extension,
    route: `${mounted.route.method} ${mounted.fullPath}`,
    requestId,
  });
  const finish = (response: Response): Response => {
    deps.onResult?.({
      extension,
      status: response.status,
      seconds: (performance.now() - started) / 1000,
    });
    return response;
  };

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > deps.maxBodyBytes)
    return finish(json(413, 'payload_too_large', requestId, { limitBytes: deps.maxBodyBytes }));

  let actor: Actor | null = null;
  try {
    actor = (await deps.resolveActor?.(request)) ?? null;
    if (mounted.route.public !== true) {
      await deps.kernel.authorizer.authorize(actor, mounted.route.permission as string);
    }
  } catch (error) {
    if (error instanceof ForbiddenError)
      return finish(json(actor ? 403 : 401, actor ? 'forbidden' : 'unauthenticated', requestId));
    log.error({ err: error }, 'authorization failed');
    return finish(json(500, 'internal_error', requestId));
  }

  const controller = new AbortController();
  try {
    const base = deps.kernel.contextFor(extension, controller.signal);
    const ctx = { ...base, actor, requestId, params } as RouteContext & {
      params: Record<string, string>;
    };
    const response = await withTimeout(
      Promise.resolve(
        (mounted.route.handler as (r: Request, c: unknown) => Promise<unknown>)(request, ctx),
      ),
      deps.timeoutMs,
      `${extension} ${mounted.route.method} ${mounted.route.path}`,
    );
    if (!(response instanceof Response)) {
      log.error({ returned: typeof response }, 'extension route did not return a Response');
      return finish(json(500, 'internal_error', requestId));
    }
    const out = new Response(response.body, response);
    if (!out.headers.has('cache-control')) out.headers.set('cache-control', 'no-store');
    out.headers.set('x-content-type-options', 'nosniff');
    out.headers.set('x-request-id', requestId);
    return finish(out);
  } catch (error) {
    controller.abort();
    if (error instanceof TimeoutError) {
      log.error({ timeoutMs: deps.timeoutMs }, 'extension route timed out');
      return finish(json(504, 'extension_timeout', requestId));
    }
    log.error({ err: error }, 'extension route failed');
    return finish(json(500, 'internal_error', requestId));
  }
}

export type { Authorizer };
