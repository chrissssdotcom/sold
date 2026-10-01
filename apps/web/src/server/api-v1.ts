import { z } from 'zod';
import { can, isKnownPermission } from '@sold/identity';
import {
  MemoryCounters,
  checkRate,
  verifyApiKey,
  type CounterStore,
  type VerifiedKey,
} from '@sold/platform';
import { NotFoundError } from '@sold/commerce';
import { errorResponse } from './commerce-http';
import { route, type RouteContext } from './route';
import { getRuntime } from './runtime';

/** Scopes an API key may hold: concrete RBAC permissions, never `*` and never an `area:*` wildcard. */
export function validateScopes(scopes: string[]): string[] {
  return scopes.filter((s) => s === '*' || s.endsWith(':*') || !isKnownPermission(s));
}

export const money = z
  .object({ amount: z.string().regex(/^-?\d+$/), currency: z.string().length(3) })
  .meta({
    id: 'Money',
    description: 'Minor units as a string (no floats), plus ISO 4217 currency.',
  });
export const productOut = z.object({
  id: z.uuid(),
  handle: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(['draft', 'active', 'archived']),
  tags: z.array(z.string()),
  variants: z.array(
    z.object({
      id: z.uuid(),
      sku: z.string(),
      title: z.string(),
      options: z.record(z.string(), z.string()),
      prices: z.array(
        z.object({ currency: z.string(), amount: z.string(), compareAt: z.string().nullable() }),
      ),
    }),
  ),
});
export const orderOut = z.object({
  id: z.uuid(),
  number: z.string(),
  status: z.string(),
  email: z.string(),
  placedAt: z.string(),
  subtotal: money,
  discountTotal: money,
  shippingTotal: money,
  taxTotal: money,
  total: money,
  lines: z.array(
    z.object({
      sku: z.string(),
      title: z.string(),
      quantity: z.number().int(),
      unitPrice: money,
      lineTotal: money,
    }),
  ),
});
export const orderSummary = z.object({
  id: z.uuid(),
  number: z.string(),
  status: z.string(),
  email: z.string(),
  placedAt: z.string(),
  total: money,
});
export const errorOut = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
export const stockIn = z.strictObject({
  onHand: z.number().int().min(0).max(10_000_000),
  allowBackorder: z.boolean().optional(),
});

export interface ApiContext extends RouteContext {
  key: VerifiedKey;
}

const holder = globalThis as unknown as { __soldApiCounters?: CounterStore };
function counters(): CounterStore {
  const redis = getRuntime().redis;
  if (redis)
    return {
      async incr(key, ttl) {
        const n = await redis.incr(key);
        if (n === 1) await redis.expire(key, ttl);
        return n;
      },
    };
  return (holder.__soldApiCounters ??= new MemoryCounters());
}

const PER_MINUTE = 600;

const fail = (
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
) =>
  Response.json(
    { error: { code, message } },
    { status, headers: { 'cache-control': 'no-store', ...headers } },
  );

/**
 * A public API route. Authentication is a bearer API key ONLY: cookies are never read here, so a logged-in browser cannot be
 * made to call it cross-site (no CSRF surface). Order: key -> rate limit -> scope -> handler. Failures never say which part of
 * a key was wrong.
 */
export function apiRoute(
  scope: string,
  handler: (request: Request, ctx: ApiContext) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return route(async (request, ctx) => {
    const header = request.headers.get('authorization') ?? '';
    const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1] ?? null;
    const key = await verifyApiKey(getRuntime().db.primary, token);
    if (!key)
      return fail(
        401,
        'unauthenticated',
        'Provide a valid API key as "Authorization: Bearer sk_..."',
        { 'www-authenticate': 'Bearer' },
      );
    const limit = await checkRate(counters(), key.id, PER_MINUTE);
    const rl = {
      'x-ratelimit-limit': String(limit.limit),
      'x-ratelimit-remaining': String(limit.remaining),
    };
    if (!limit.allowed)
      return fail(429, 'rate_limited', 'Too many requests', {
        ...rl,
        'retry-after': String(limit.retryAfterSeconds),
      });
    if (!can(key.scopes, scope))
      return fail(403, 'forbidden', `This key lacks the "${scope}" scope`, rl);
    try {
      const res = await handler(request, { ...ctx, key });
      for (const [k, v] of Object.entries(rl)) res.headers.set(k, v);
      res.headers.set('cache-control', 'private, no-store');
      return res;
    } catch (error) {
      if (error instanceof NotFoundError || (error as { code?: string }).code === 'not_found')
        return fail(404, 'not_found', 'Not found', rl);
      return errorResponse(error);
    }
  });
}

export function pageParams(request: Request) {
  const sp = new URL(request.url).searchParams;
  const limit = Math.min(Math.max(Number(sp.get('limit') ?? 25) || 25, 1), 50);
  const before = sp.get('before') ?? undefined;
  return { limit, before, status: sp.get('status') ?? undefined };
}

export const lastSegment = (request: Request, fromEnd = 0) => {
  const parts = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(parts[parts.length - 1 - fromEnd] ?? '');
};

export const moneyJson = (m: { toJSON(): { amount: string; currency: string } }) => m.toJSON();
