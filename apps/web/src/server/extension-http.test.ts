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
    expect(res.headers.get('cache-control')).toBe('no-store'); // never CDN-cacheable by accident
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-request-id')).toBe('req-12345678');
    expect(results).toEqual([expect.objectContaining({ extension: 'demo', status: 200 })]);
  });

  it('lets an extension opt in to caching explicitly', async () => {
    const { call } = setup([
      {
        ...publicGet,
        handler: async () =>
          new Response('x', { headers: { 'cache-control': 'public, max-age=60' } }),
      },
    ]);
    expect((await call('/x/demo/hello')).headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('404 for unknown routes and 405 with Allow for wrong methods', async () => {
    const { call } = setup([publicGet]);
    expect((await call('/x/demo/nothing')).status).toBe(404);
    expect((await call('/x/other/hello')).status).toBe(404);
    const res = await call('/x/demo/hello', { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
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
    expect((logged[0] as [{ err: Error }])[0].err.message).toContain('exploded'); // the operator sees the cause; the shopper never does
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
