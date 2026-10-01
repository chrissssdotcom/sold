import { defineExtension, type ExtensionManifest } from '@sold/extension-sdk';
import { ForbiddenError, RouteTable, type Authorizer } from '@sold/core/extensions';
import { describe, expect, it, vi } from 'vitest';
import { handleExtensionRequest, type ExtensionHttpDeps } from './extension-http';

const ok = async () => new Response('ok');
const manifest = (
  routes: NonNullable<Parameters<typeof defineExtension>[0]['routes']>,
): ExtensionManifest =>
  defineExtension({
    name: 'demo',
    version: '1.0.0',
    requires: { base: '*' },
    performance: { hotPath: false },
    permissions: [{ key: 'demo.things.read', description: 'read' }],
    routes,
  });

function setup(
  routes: Parameters<typeof manifest>[0],
  over: Partial<ExtensionHttpDeps> = {},
  authorizer?: Authorizer,
) {
  const table = new RouteTable();
  table.add(manifest(routes));
  const logged: unknown[] = [];
  const log = { child: () => log, warn: vi.fn(), error: (...a: unknown[]) => void logged.push(a) };
  const results: { extension: string; status: number }[] = [];
  const deps: ExtensionHttpDeps = {
    kernel: {
      routes: table,
      authorizer: authorizer ?? { authorize: async () => undefined },
      contextFor: (extension: string, signal: AbortSignal) => ({ extension, signal }) as never,
    },
    log: log as never,
    timeoutMs: 100,
    maxBodyBytes: 1_000,
    onResult: (r) => void results.push(r),
    ...over,
  };
  return {
    deps,
    logged,
    results,
    call: (path: string, init?: RequestInit) =>
      handleExtensionRequest(deps, new Request(`http://localhost${path}`, init), 'req-12345678'),
  };
}

const publicGet = {
  kind: 'api' as const,
  method: 'GET' as const,
  path: '/hello',
  public: true,
  handler: async () => Response.json({ hi: 1 }),
};

describe('handleExtensionRequest', () => {
  it('serves a public route with safe default headers and records the result', async () => {
    const { call, results } = setup([publicGet]);
    const res = await call('/x/demo/hello');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hi: 1 });
    expect(res.headers.get('cache-control')).toBe('private, no-store'); // never CDN-cacheable by accident
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-request-id')).toBe('req-12345678');
    expect(results).toEqual([expect.objectContaining({ extension: 'demo', status: 200 })]);
  });

  it('lets a route opt in to caching by declaring it; the extension cannot set Cache-Control itself', async () => {
    const declared = setup([
      { ...publicGet, cache: { maxAgeSeconds: 60, scope: 'public' as const } },
    ]);
    expect((await declared.call('/x/demo/hello')).headers.get('cache-control')).toBe(
      'public, max-age=60',
    );
    const priv = setup([{ ...publicGet, cache: { maxAgeSeconds: 30 } }]);
    expect((await priv.call('/x/demo/hello')).headers.get('cache-control')).toBe(
      'private, max-age=30',
    );
    const sneaky = setup([
      {
        ...publicGet,
        handler: async () =>
          Response.json({}, { headers: { 'cache-control': 'public, max-age=31536000' } }),
      },
    ]);
    expect((await sneaky.call('/x/demo/hello')).headers.get('cache-control')).toBe(
      'private, no-store',
    );
  });

  it('404 for unknown routes and 405 with Allow for wrong methods', async () => {
    const { call } = setup([publicGet]);
    expect((await call('/x/demo/nothing')).status).toBe(404);
    expect((await call('/x/other/hello')).status).toBe(404);
    const res = await call('/x/demo/hello', { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });

  it('non-public routes fail closed without an actor (401) and are denied by the authorizer (403)', async () => {
    const guarded = {
      kind: 'api' as const,
      method: 'GET' as const,
      path: '/things',
      permission: 'demo.things.read',
      handler: vi.fn(ok),
    };
    const denyAll: Authorizer = {
      authorize: async (_s, p) => {
        throw new ForbiddenError(p);
      },
    };
    const anonymous = setup([guarded], {}, denyAll);
    expect((await anonymous.call('/x/demo/things')).status).toBe(401);
    const known = setup(
      [guarded],
      { resolveActor: async () => ({ id: 'u1', kind: 'admin' }) },
      denyAll,
    );
    expect((await known.call('/x/demo/things')).status).toBe(403);
    expect(guarded.handler).not.toHaveBeenCalled(); // the handler never ran
  });

  it('checks the declared permission through authorize()', async () => {
    const authorize = vi.fn(async () => undefined);
    const guarded = {
      kind: 'api' as const,
      method: 'GET' as const,
      path: '/things',
      permission: 'demo.things.read',
      handler: ok,
    };
    const { call } = setup(
      [guarded],
      { resolveActor: async () => ({ id: 'u1', kind: 'admin' }) },
      { authorize },
    );
    expect((await call('/x/demo/things')).status).toBe(200);
    expect(authorize).toHaveBeenCalledWith({ id: 'u1', kind: 'admin' }, 'demo.things.read');
  });

  it('rejects oversized bodies before running the handler', async () => {
    const handler = vi.fn(ok);
    const { call } = setup([{ kind: 'api', method: 'POST', path: '/in', public: true, handler }]);
    const res = await call('/x/demo/in', {
      method: 'POST',
      headers: { 'content-length': '5000' },
      body: 'x',
    });
    expect(res.status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });

  it('turns a throwing handler into a structured 500 with the request id, logging the extension, leaking nothing', async () => {
    const { call, logged } = setup([
      {
        ...publicGet,
        handler: async () => {
          throw new Error('db password=hunter2 exploded');
        },
      },
    ]);
    const res = await call('/x/demo/hello');
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain('req-12345678');
    expect(body).not.toMatch(/hunter2|exploded/);
    const fields = (logged[0] as [Record<string, unknown>])[0];
    expect(fields.errorClass).toBe('Error');
    expect(fields.message).toContain('exploded'); // the operator sees the cause; the shopper never does
    expect(JSON.stringify(logged)).not.toContain('hunter2'); // ...but never the secret in it
  });

  it('enforces a hard timeout (504)', async () => {
    const { call } = setup(
      [{ ...publicGet, handler: () => new Promise<Response>(() => undefined) }],
      { timeoutMs: 30 },
    );
    expect((await call('/x/demo/hello')).status).toBe(504);
  });

  it('rejects a handler that returns something other than a Response', async () => {
    const { call } = setup([{ ...publicGet, handler: (async () => ({ nope: true })) as never }]);
    expect((await call('/x/demo/hello')).status).toBe(500);
  });

  it('never matches encoded traversal into other routes', async () => {
    const { call } = setup([publicGet]);
    expect((await call('/x/demo/..%2fhello')).status).toBe(404);
  });
});

describe('handleExtensionRequest: customer routes', () => {
  const route = {
    kind: 'api' as const,
    method: 'POST' as const,
    path: '/mine',
    customer: true,
    handler: async (_r: Request, ctx: { actor: { id: string } | null }) =>
      Response.json({ who: ctx.actor?.id }),
  };
  const post = { method: 'POST' };
  it('lets a signed-in customer in and scopes the handler to their id', async () => {
    const { call } = setup([route as never], {
      resolveActor: async () => ({ id: 'c1', kind: 'customer' }),
    });
    const res = await call('/x/demo/mine', post);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ who: 'c1' });
  });
  it('refuses anonymous callers (401) and staff acting as customers (403)', async () => {
    const anon = setup([route as never], { resolveActor: async () => null });
    expect((await anon.call('/x/demo/mine', post)).status).toBe(401);
    const staff = setup([route as never], {
      resolveActor: async () => ({ id: 'a1', kind: 'admin' }),
    });
    expect((await staff.call('/x/demo/mine', post)).status).toBe(403);
  });
  it('never consults the permission authorizer for a customer route', async () => {
    const authorize = vi.fn(async () => undefined);
    const { call } = setup(
      [route as never],
      { resolveActor: async () => ({ id: 'c1', kind: 'customer' }) },
      { authorize },
    );
    await call('/x/demo/mine', post);
    expect(authorize).not.toHaveBeenCalled();
  });
});

describe('handleExtensionRequest: request bodies are limited by bytes read, not by Content-Length', () => {
  const chunked = (chunks: number, size: number) => {
    const chunk = new Uint8Array(size).fill(65);
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ < chunks) c.enqueue(chunk);
        else c.close();
      },
    });
  };
  const post = (body: BodyInit) => ({ method: 'POST', body, duplex: 'half' }) as RequestInit;

  it('a chunked 30 MB body against a 1 KB limit is refused with 413 and the handler stops reading early', async () => {
    let read = 0;
    const { call } = setup([
      {
        kind: 'webhook',
        method: 'POST',
        path: '/hook',
        public: true,
        handler: async (req: Request) => {
          for await (const part of req.body as unknown as AsyncIterable<Uint8Array>)
            read += part.byteLength;
          return Response.json({ read });
        },
      },
    ]);
    const res = await call('/x/demo/hook', post(chunked(30, 1024 * 1024)));
    expect(res.status).toBe(413);
    expect(read).toBeLessThan(1_000 + 1024 * 1024 + 1); // stopped at the first chunk that crossed the limit
  });

  it('a handler that swallows the read error still cannot answer 200 for an over-limit body', async () => {
    const { call } = setup([
      {
        kind: 'webhook',
        method: 'POST',
        path: '/hook',
        public: true,
        handler: async (req: Request) => {
          await req.text().catch(() => 'ignored');
          return Response.json({ ok: true });
        },
      },
    ]);
    expect((await call('/x/demo/hook', post(chunked(4, 1024)))).status).toBe(413);
  });

  it('a body within the limit is delivered intact', async () => {
    const { call } = setup([
      {
        kind: 'webhook',
        method: 'POST',
        path: '/hook',
        public: true,
        handler: async (req: Request) => Response.json({ got: (await req.text()).length }),
      },
    ]);
    const res = await call('/x/demo/hook', post(chunked(2, 400)));
    expect(await res.json()).toEqual({ got: 800 });
  });
});

describe('handleExtensionRequest: deadlines cover the response body and cancel cooperatively', () => {
  const slowStream = (intervalMs: number, chunks: number, onCancel?: () => void) => {
    let n = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return new ReadableStream<Uint8Array>({
      pull: (c) =>
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            if (++n > chunks) c.close();
            else c.enqueue(new TextEncoder().encode('x'));
            resolve();
          }, intervalMs);
        }),
      cancel() {
        clearTimeout(timer);
        onCancel?.();
      },
    });
  };

  it('a stream that outlives the deadline is cut: the client stream errors and the producer is cancelled', async () => {
    let cancelled = false;
    let aborted = false;
    const { call } = setup(
      [
        {
          ...publicGet,
          handler: async (_r: Request, ctx: { signal: AbortSignal }) => {
            ctx.signal.addEventListener('abort', () => (aborted = true));
            return new Response(
              slowStream(20, 100, () => (cancelled = true)),
              {
                headers: { 'content-type': 'text/plain' },
              },
            );
          },
        },
      ],
      { timeoutMs: 120 },
    );
    const started = performance.now();
    const res = await call('/x/demo/hello');
    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(1_000); // not the ~2 s the producer wanted
    expect(cancelled).toBe(true);
    expect(aborted).toBe(true);
  });

  it('a fast body is unaffected', async () => {
    const { call } = setup([
      {
        ...publicGet,
        handler: async () =>
          new Response(slowStream(1, 3), { headers: { 'content-type': 'text/plain' } }),
      },
    ]);
    expect(await (await call('/x/demo/hello')).text()).toBe('xxx');
  });

  it('on timeout the request signal aborts too, and work that finishes later is logged, not lost', async () => {
    let requestAborted = false;
    let finished = false;
    const warn = vi.fn();
    const { call, deps } = setup(
      [
        {
          ...publicGet,
          handler: async (req: Request) => {
            req.signal.addEventListener('abort', () => (requestAborted = true));
            await new Promise((r) => setTimeout(r, 120));
            finished = true; // a handler that ignores the signal: JavaScript cannot stop it
            return new Response('late');
          },
        },
      ],
      { timeoutMs: 30 },
    );
    (deps.log as { warn: unknown }).warn = warn;
    expect((await call('/x/demo/hello')).status).toBe(504);
    expect(requestAborted).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(finished).toBe(true); // honest: cooperative cancellation only
    expect(warn).toHaveBeenCalledWith({}, expect.stringContaining('after its timeout'));
  });

  it('runs the handler attributed to its extension (so a stray rejection is contained, not fatal)', async () => {
    const { currentExtensionScope } = await import('@sold/core/extensions');
    let scope: unknown;
    const { call } = setup([
      {
        ...publicGet,
        handler: async () => {
          scope = currentExtensionScope();
          return Response.json({});
        },
      },
    ]);
    await call('/x/demo/hello');
    expect(scope).toMatchObject({ extension: 'demo', kind: 'route' });
  });
});

describe('handleExtensionRequest: extension responses are filtered', () => {
  const respond = (init: () => Response, route: Record<string, unknown> = {}) =>
    setup([{ ...publicGet, ...route, handler: async () => init() }]);

  it('strips cookies and page-wide policy headers, whatever their case, and forces nosniff', async () => {
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.append('Set-Cookie', '__Host-session=attacker; Path=/; Secure; HttpOnly');
    headers.append('Set-Cookie', 'other=1; Domain=example.com');
    for (const [k, v] of Object.entries({
      'Content-Security-Policy': 'default-src *',
      'Content-Security-Policy-Report-Only': 'default-src *',
      'Strict-Transport-Security': 'max-age=0',
      'Clear-Site-Data': '"cookies"',
      Refresh: '0; url=https://evil.example/',
      Link: '<https://evil.example/>; rel=preload',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'true',
      'X-Frame-Options': 'ALLOWALL',
      'Permissions-Policy': 'camera=*',
      'X-Content-Type-Options': 'sniff',
      'X-Request-Id': 'forged',
      Pragma: 'x',
      Expires: 'Wed, 21 Oct 2099 07:28:00 GMT',
      'X-Custom': 'kept',
    }))
      headers.set(k, v);
    const { call } = respond(() => new Response('{}', { headers }));
    const res = await call('/x/demo/hello');
    expect(res.status).toBe(200);
    for (const name of [
      'set-cookie',
      'content-security-policy',
      'content-security-policy-report-only',
      'strict-transport-security',
      'clear-site-data',
      'refresh',
      'link',
      'access-control-allow-origin',
      'access-control-allow-credentials',
      'x-frame-options',
      'permissions-policy',
      'pragma',
      'expires',
    ])
      expect(res.headers.has(name), name).toBe(false);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-request-id')).toBe('req-12345678');
    expect(res.headers.get('x-custom')).toBe('kept'); // ordinary headers pass
  });

  it('strips hop-by-hop headers, including any the Connection header names', async () => {
    const { call } = respond(
      () =>
        new Response('{}', {
          headers: {
            'content-type': 'application/json',
            connection: 'x-drop-me',
            'x-drop-me': '1',
            'keep-alive': 'timeout=5',
            'transfer-encoding': 'chunked',
            upgrade: 'websocket',
          },
        }),
    );
    const res = await call('/x/demo/hello');
    for (const name of ['connection', 'x-drop-me', 'keep-alive', 'upgrade'])
      expect(res.headers.has(name), name).toBe(false);
  });

  it('redirects need `redirects: true`; even then only to a path or an http(s) URL', async () => {
    const redirect = (location: string) => () =>
      new Response(null, { status: 302, headers: { location } });
    expect((await respond(redirect('/x/demo/other')).call('/x/demo/hello')).status).toBe(500);
    const ok = respond(redirect('/x/demo/other'), { redirects: true });
    const res = await ok.call('/x/demo/hello');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/x/demo/other');
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', '//evil.example/x', ''])
      expect(
        (await respond(redirect(bad), { redirects: true }).call('/x/demo/hello')).status,
        bad,
      ).toBe(500);
  });

  it('only inert content types: html needs `html: true` and is sandboxed; svg is sandboxed too', async () => {
    const html = () =>
      new Response('<script>alert(1)</script>', { headers: { 'content-type': 'text/html' } });
    const refused = await respond(html).call('/x/demo/hello');
    expect(refused.status).toBe(500);
    expect(await refused.text()).not.toContain('<script>');
    const allowed = await respond(html, { html: true }).call('/x/demo/hello');
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('content-type')).toContain('text/html');
    expect(allowed.headers.get('content-security-policy')).toBe('sandbox');
    const svg = await respond(
      () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }),
    ).call('/x/demo/hello');
    expect(svg.headers.get('content-security-policy')).toBe('sandbox');
    for (const type of [
      'application/json; charset=utf-8',
      'text/plain',
      'text/csv',
      'application/octet-stream',
      'application/pdf',
      'image/png',
    ])
      expect(
        (
          await respond(() => new Response('x', { headers: { 'content-type': type } })).call(
            '/x/demo/hello',
          )
        ).status,
        type,
      ).toBe(200);
    for (const type of [
      'application/xml',
      'text/javascript',
      'application/xhtml+xml',
      'multipart/mixed',
    ])
      expect(
        (
          await respond(() => new Response('x', { headers: { 'content-type': type } })).call(
            '/x/demo/hello',
          )
        ).status,
        type,
      ).toBe(500);
  });

  it('a body with no content type is served as application/octet-stream (nosniff)', async () => {
    const res = await respond(() => new Response(new Uint8Array([1, 2, 3]))).call('/x/demo/hello');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('bodiless statuses are fine (204)', async () => {
    const res = await respond(() => new Response(null, { status: 204 })).call('/x/demo/hello');
    expect(res.status).toBe(204);
  });
});

describe('handleExtensionRequest: HEAD', () => {
  it('is answered from the GET route, without a body, and the handler sees a GET', async () => {
    let method = '';
    let cancelled = false;
    const { call } = setup([
      {
        ...publicGet,
        handler: async (req: Request) => {
          method = req.method;
          return new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode('{"hi":1}'));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        },
      },
    ]);
    const res = await call('/x/demo/hello', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe('');
    expect(method).toBe('GET');
    expect(cancelled).toBe(true);
  });

  it('does not exist for routes that are not GET', async () => {
    const { call } = setup([
      { kind: 'api', method: 'POST', path: '/in', public: true, handler: ok },
    ]);
    const res = await call('/x/demo/in', { method: 'HEAD' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });
});

describe('handleExtensionRequest: logs carry the error class and a scrubbed message only', () => {
  it('scrubs credentials, tokens and URLs with passwords from every logged field', async () => {
    const secrets = ['hunter2', 'abcdefghij123456', 'sk_live_abcdefghijklmnop', 'p4ssw0rd'];
    const { call, logged } = setup([
      {
        ...publicGet,
        handler: async () => {
          throw new TypeError(
            `connect postgres://app:p4ssw0rd@db:5432/x failed; password=hunter2; Authorization: Bearer abcdefghij123456; key sk_live_abcdefghijklmnop`,
          );
        },
      },
    ]);
    expect((await call('/x/demo/hello')).status).toBe(500);
    const text = JSON.stringify(logged);
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect((logged[0] as [Record<string, unknown>])[0]).toMatchObject({ errorClass: 'TypeError' });
  });

  it('also when the authorizer itself fails', async () => {
    const { call, logged } = setup(
      [{ kind: 'api', method: 'GET', path: '/g', permission: 'demo.things.read', handler: ok }],
      {},
      {
        authorize: async () => {
          throw new Error('redis://:hunter2@cache:6379 unreachable');
        },
      },
    );
    expect((await call('/x/demo/g')).status).toBe(500);
    expect(JSON.stringify(logged)).not.toContain('hunter2');
  });
});
