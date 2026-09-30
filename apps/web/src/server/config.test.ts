import { environmentNames, safetySwitchesFor } from '@sold/core/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '../proxy';

afterEach(() => vi.unstubAllEnvs());

describe('proxy: request id and indexing', () => {
  it.each(environmentNames)(
    'X-Robots-Tag at request time agrees with safetySwitchesFor(%s).blockIndexing',
    (environment) => {
      vi.stubEnv('SOLD_ENVIRONMENT', environment);
      const res = proxy(new NextRequest('http://localhost/en-au'));
      expect(res.headers.has('x-robots-tag')).toBe(safetySwitchesFor(environment).blockIndexing);
    },
  );

  it('assigns a request id and keeps a well-formed inbound one', () => {
    const generated = proxy(new NextRequest('http://localhost/en-au')).headers.get('x-request-id');
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
    const kept = proxy(
      new NextRequest('http://localhost/en-au', { headers: { 'x-request-id': 'req-12345678' } }),
    );
    expect(kept.headers.get('x-request-id')).toBe('req-12345678');
    const hostile = proxy(
      new NextRequest('http://localhost/en-au', { headers: { 'x-request-id': 'bad id!' } }),
    );
    expect(hostile.headers.get('x-request-id')).not.toBe('bad id!');
  });
});

describe('proxy: market prefix', () => {
  const redirect = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    proxy(new NextRequest(`http://localhost${path}`, { headers, method }));

  it('sends unprefixed storefront paths to the negotiated market, keeping path and query', () => {
    const r = redirect('/products?x=1', { 'accept-language': 'en-US,en;q=0.9' });
    expect(r.status).toBe(307);
    expect(r.headers.get('location')).toBe('http://localhost/en-us/products?x=1');
    expect(redirect('/').headers.get('location')).toBe('http://localhost/en-au');
    expect(r.headers.get('vary')).toContain('Accept-Language');
  });

  it('leaves prefixed paths, APIs, assets and non-GET requests alone', () => {
    for (const path of [
      '/en-au/products',
      '/api/cart',
      '/x/ext/thing',
      '/metrics',
      '/art/hero.svg',
      '/robots.txt',
    ])
      expect(redirect(path).status, path).toBe(200);
    expect(redirect('/products', {}, 'POST').status).toBe(200);
  });
});

describe('next.config security headers', () => {
  it('sets the baseline hardening headers and nothing environment-dependent', async () => {
    const { securityHeaders } = await import('../../next.config');
    const keys = securityHeaders.map((h) => h.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'Strict-Transport-Security',
        'X-Content-Type-Options',
        'X-Frame-Options',
        'Referrer-Policy',
      ]),
    );
    expect(keys).not.toContain('X-Robots-Tag');
  });
});
