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
      const res = proxy(new NextRequest('http://localhost/'));
      expect(res.headers.has('x-robots-tag')).toBe(safetySwitchesFor(environment).blockIndexing);
    },
  );

  it('assigns a request id and keeps a well-formed inbound one', () => {
    const generated = proxy(new NextRequest('http://localhost/')).headers.get('x-request-id');
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
    const kept = proxy(
      new NextRequest('http://localhost/', { headers: { 'x-request-id': 'req-12345678' } }),
    );
    expect(kept.headers.get('x-request-id')).toBe('req-12345678');
    const hostile = proxy(
      new NextRequest('http://localhost/', { headers: { 'x-request-id': 'bad id!' } }),
    );
    expect(hostile.headers.get('x-request-id')).not.toBe('bad id!');
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
