import { withTimeout, TimeoutError } from '@sold/core/resilience';
import {
  ForbiddenError,
  runAsExtension,
  type Kernel,
  type Authorizer,
} from '@sold/core/extensions';
import { scrubString, type Logger } from '@sold/core/observability';
import type { Actor, RouteContext, RouteDefinition } from '@sold/extension-sdk';

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

/** Response headers an extension may never set: they belong to Base, the platform or the edge. */
const STRIPPED_HEADERS = new Set([
  // identity / session
  'set-cookie',
  'set-cookie2',
  // navigation and page-wide policy
  'location', // only kept for routes that declare `redirects: true`
  'refresh',
  'link',
  'content-security-policy',
  'content-security-policy-report-only',
  'strict-transport-security',
  'clear-site-data',
  'permissions-policy',
  'x-frame-options',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'report-to',
  'nel',
  'alt-svc',
  'public-key-pins',
  'public-key-pins-report-only',
  // cross-origin access is a Base decision, not an extension's
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'access-control-max-age',
  // framing and transport (recomputed by the platform)
  'content-length',
  'content-encoding',
  // hop-by-hop (RFC 9110 7.6.1)
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // owned by Base
  'x-request-id',
  'x-content-type-options',
  'cache-control',
  'age',
  'expires',
  'pragma',
]);

/** Content types an extension route may return. `text/html` additionally needs `html: true` on the route. */
const ALLOWED_TYPES = new Set([
  'application/json',
  'text/plain',
  'text/csv',
  'application/octet-stream',
  'application/pdf',
]);
const NO_BODY_STATUS = new Set([101, 204, 205, 304]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * Brand check instead of `instanceof`: a bundler can load @sold/core twice (one copy per route graph), and an error thrown
 * by one copy's authorizer would then fall through to the 500 path instead of the 401/403 it is.
 */
function isForbidden(error: unknown): error is ForbiddenError {
  return (
    error instanceof Error &&
    error.name === 'ForbiddenError' &&
    (error as { status?: number }).status === 403
  );
}

class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`request body exceeds ${limit} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

/** What went wrong, without what the message might contain: class, scrubbed message and scrubbed stack. */
function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error)
    return {
      errorClass: error.name,
      message: scrubString(error.message),
      ...(error.stack ? { stack: scrubString(error.stack).slice(0, 2_000) } : {}),
    };
  return { errorClass: typeof error, message: scrubString(String(error)).slice(0, 500) };
}

/**
 * Count the bytes of a request body as it is read and fail the read once it exceeds `limit`. `Content-Length`
 * is only what the client claims; a chunked body has none. `state.exceeded` lets the caller answer 413.
 */
function limitRequestBody(
  body: ReadableStream<Uint8Array>,
  limit: number,
  state: { exceeded: boolean },
): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > limit) {
          state.exceeded = true;
          controller.error(new BodyTooLargeError(limit));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

/**
 * Give a response body the same deadline as the handler. When it passes, the source stream is cancelled, the
 * handler's signal is aborted and the client's stream errors, so a slow producer cannot hold a connection open.
 */
function limitResponseBody(
  body: ReadableStream<Uint8Array>,
  remainingMs: number,
  onTimeout: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setTimeout(
        () => {
          if (finished) return;
          finished = true;
          onTimeout();
          reader.cancel(new TimeoutError('response body', remainingMs)).catch(() => undefined);
          controller.error(new TimeoutError('response body', remainingMs));
        },
        Math.max(1, remainingMs),
      );
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (finished) return;
        if (done) {
          finished = true;
          clearTimeout(timer);
          controller.close();
        } else controller.enqueue(value);
      } catch (error) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        controller.error(error);
      }
    },
    cancel(reason) {
      finished = true;
      clearTimeout(timer);
      return reader.cancel(reason);
    },
  });
}

const mediaType = (value: string | null): string | null =>
  value ? (value.split(';')[0] ?? '').trim().toLowerCase() : null;

interface Sanitized {
  response: Response | null;
  /** Why the response was refused, for the operator log. */
  problem?: string;
}

/**
 * Whatever an extension returns is filtered before it reaches the browser: no cookies or page-wide policy headers,
 * only inert content types, `nosniff`, and `Cache-Control: private, no-store` unless the route declares `cache`.
 */
function sanitizeResponse(
  response: Response,
  route: RouteDefinition<never>,
  opts: {
    requestId: string;
    head: boolean;
    remainingMs: number;
    onBodyTimeout: () => void;
  },
): Sanitized {
  const { status } = response;
  if (status < 200 || status > 599)
    return { response: null, problem: `status ${status} not allowed` };
  const redirect = REDIRECT_STATUS.has(status);
  if (redirect && route.redirects !== true)
    return { response: null, problem: 'redirect from a route without `redirects: true`' };

  const headers = new Headers();
  const named = new Set(
    (response.headers.get('connection') ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [name, value] of response.headers) {
    if (STRIPPED_HEADERS.has(name) || named.has(name)) continue;
    headers.append(name, value);
  }

  if (redirect) {
    const location = response.headers.get('location');
    // Same-origin paths or http(s) URLs only: `javascript:` and `data:` navigations are never a redirect.
    if (!location || !/^(\/(?!\/)|https?:\/\/)/i.test(location))
      return { response: null, problem: 'redirect without a usable Location' };
    headers.set('location', location);
  }

  const hasBody = response.body !== null && !NO_BODY_STATUS.has(status) && !redirect;
  if (hasBody) {
    const type = mediaType(response.headers.get('content-type')) ?? 'application/octet-stream';
    const isHtml = type === 'text/html' || type === 'application/xhtml+xml';
    const allowed =
      ALLOWED_TYPES.has(type) || type.startsWith('image/') || (isHtml && route.html === true);
    if (!allowed)
      return {
        response: null,
        problem: `content type "${type}" is not allowed${isHtml ? ' (declare `html: true` on the route)' : ''}`,
      };
    if (!response.headers.has('content-type')) headers.set('content-type', type);
    // HTML and SVG can run script when navigated to directly: serve them in a sandbox (no scripts, no forms).
    if (isHtml || type === 'image/svg+xml') headers.set('content-security-policy', 'sandbox');
  }

  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-request-id', opts.requestId);
  headers.set(
    'cache-control',
    route.cache
      ? `${route.cache.scope === 'public' ? 'public' : 'private'}, max-age=${route.cache.maxAgeSeconds}`
      : 'private, no-store',
  );

  let body: BodyInit | null = null;
  if (hasBody && response.body) {
    if (opts.head) {
      // HEAD mirrors GET without the body, and must not leave the producer running.
      response.body.cancel().catch(() => undefined);
      const length = response.headers.get('content-length');
      if (length) headers.set('content-length', length);
    } else {
      body = limitResponseBody(response.body, opts.remainingMs, opts.onBodyTimeout);
    }
  } else if (response.body) {
    response.body.cancel().catch(() => undefined);
  }
  return {
    response: new Response(body, { status, statusText: response.statusText, headers }),
  };
}

/**
 * Serves `/x/<extension>/...` and `/admin/x/<extension>/...`: the ONLY door through which extension code handles
 * an HTTP request. Guarantees, whatever the extension does:
 *  - routes are mounted under a reserved prefix, so they cannot shadow Base routes;
 *  - permission is checked through the single `authorize()` primitive before the handler runs; a route is either
 *    explicitly `public` or permissioned, and with no actor resolver non-public routes are denied (fail closed);
 *  - request bodies are capped by bytes actually read (chunked bodies included), not by the client's
 *    `Content-Length`; the handler has a deadline that also covers the response body, and its signal (and the
 *    request's) is aborted when it passes. Cancellation is cooperative: JavaScript cannot stop a handler that
 *    ignores the signal, so such work may still finish, and its late failure is contained and logged;
 *  - a thrown error, a timeout or a malformed return value becomes a structured error carrying the request ID,
 *    is logged with the extension name (class and scrubbed message only), and never reaches the shopper;
 *  - responses are filtered (see `sanitizeResponse`): no cookies or policy headers, inert content types, `nosniff`,
 *    `Cache-Control: private, no-store` unless the route declares `cache`; `redirects` and `html` are explicit
 *    per-route opt-ins;
 *  - HEAD is answered from a GET route without its body.
 */
export async function handleExtensionRequest(
  deps: ExtensionHttpDeps,
  request: Request,
  requestId: string,
): Promise<Response> {
  const started = performance.now();
  const url = new URL(request.url);
  const head = request.method.toUpperCase() === 'HEAD';
  const match = deps.kernel.routes.match(head ? 'GET' : request.method, url.pathname);
  if (match.status === 'not-found') return json(404, 'not_found', requestId);
  if (match.status === 'method-not-allowed') {
    const allowed = new Set(match.allowed);
    if (allowed.has('GET')) allowed.add('HEAD');
    return json(
      405,
      'method_not_allowed',
      requestId,
      {},
      { allow: [...allowed].sort().join(', ') },
    );
  }

  const { mounted, params } = match;
  const extension = mounted.extension;
  const routeName = `${mounted.route.method} ${mounted.fullPath}`;
  const log = deps.log.child({ extension, route: routeName, requestId });
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
    if (mounted.route.customer === true) {
      // Any signed-in customer; the handler scopes to ctx.actor.id. Staff and anonymous callers are refused.
      if (actor?.kind !== 'customer') throw new ForbiddenError('customer');
    } else if (mounted.route.public !== true) {
      await deps.kernel.authorizer.authorize(actor, mounted.route.permission as string);
    }
  } catch (error) {
    if (isForbidden(error))
      return finish(json(actor ? 403 : 401, actor ? 'forbidden' : 'unauthenticated', requestId));
    log.error(errorFields(error), 'authorization failed');
    return finish(json(500, 'internal_error', requestId));
  }

  const controller = new AbortController();
  const tooLarge = { exceeded: false };
  const deadline = started + deps.timeoutMs;
  const remaining = () => deadline - performance.now();
  let timedOut = false;
  try {
    const base = deps.kernel.contextFor(extension, controller.signal);
    const ctx = { ...base, actor, requestId, params } as RouteContext & {
      params: Record<string, string>;
    };
    // The handler sees a GET for a HEAD, a byte-limited body and a request whose signal aborts with ours.
    const init: RequestInit & { duplex?: 'half' } = {
      method: head ? 'GET' : request.method,
      headers: request.headers,
      signal: controller.signal,
    };
    if (request.body && !head) {
      init.body = limitRequestBody(request.body, deps.maxBodyBytes, tooLarge);
      init.duplex = 'half';
    }
    const handed = new Request(request.url, init);

    const work = runAsExtension({ extension, kind: 'route', name: routeName }, () =>
      Promise.resolve(
        (mounted.route.handler as (r: Request, c: unknown) => Promise<unknown>)(handed, ctx),
      ),
    );
    // Whatever happens to the race, the handler's own outcome is observed: no unhandled rejection, and a late
    // completion (work the timeout could not stop) is visible.
    work.then(
      () => {
        if (timedOut)
          log.warn({}, 'extension route finished after its timeout; its work was not cancelled');
      },
      (error: unknown) => {
        if (timedOut) log.warn(errorFields(error), 'extension route failed after its timeout');
      },
    );
    const response = await withTimeout(
      work,
      Math.max(1, remaining()),
      `${extension} ${mounted.route.method} ${mounted.route.path}`,
    );
    if (tooLarge.exceeded) {
      controller.abort();
      return finish(json(413, 'payload_too_large', requestId, { limitBytes: deps.maxBodyBytes }));
    }
    if (!(response instanceof Response)) {
      log.error({ returned: typeof response }, 'extension route did not return a Response');
      return finish(json(500, 'internal_error', requestId));
    }
    const safe = sanitizeResponse(response, mounted.route, {
      requestId,
      head,
      remainingMs: remaining(),
      onBodyTimeout: () => {
        timedOut = true;
        controller.abort();
        log.error({ timeoutMs: deps.timeoutMs }, 'extension route response body timed out');
      },
    });
    if (!safe.response) {
      response.body?.cancel().catch(() => undefined);
      log.error(
        { problem: safe.problem },
        'extension route returned a response Base refuses to send',
      );
      return finish(json(500, 'internal_error', requestId));
    }
    return finish(safe.response);
  } catch (error) {
    controller.abort();
    if (tooLarge.exceeded || error instanceof BodyTooLargeError)
      return finish(json(413, 'payload_too_large', requestId, { limitBytes: deps.maxBodyBytes }));
    if (error instanceof TimeoutError) {
      timedOut = true;
      log.error({ timeoutMs: deps.timeoutMs }, 'extension route timed out');
      return finish(json(504, 'extension_timeout', requestId));
    }
    log.error(errorFields(error), 'extension route failed');
    return finish(json(500, 'internal_error', requestId));
  }
}

export type { Authorizer };
