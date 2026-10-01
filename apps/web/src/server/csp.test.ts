import { describe, expect, it } from 'vitest';
import { buildCsp, cspMode, parseHosts } from './csp';

describe('csp', () => {
  it('console posture: nonce + strict-dynamic, no unsafe-inline for scripts', () => {
    const csp = buildCsp({ nonce: 'abc123' });
    const script = csp.split('; ').find((d) => d.startsWith('script-src'))!;
    expect(script).toBe("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(script).not.toContain('unsafe-inline');
  });

  it('storefront posture: allowlisted hosts only, always locked-down non-script directives', () => {
    const csp = buildCsp({ scriptHosts: ['https://analytics.tiktok.com'] });
    expect(csp).toContain("script-src 'self' 'unsafe-inline' https://analytics.tiktok.com");
    for (const d of [
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
      "default-src 'self'",
    ])
      expect(csp).toContain(d);
    expect(csp).not.toContain('unsafe-eval');
  });

  it('frame hosts extend frame-src only', () => {
    const csp = buildCsp({ frameHosts: ['https://www.tiktok.com'] });
    expect(csp).toContain("frame-src 'self' https://www.tiktok.com");
    expect(csp).toContain("default-src 'self'");
  });

  it('eval and websockets only in dev', () => {
    expect(buildCsp({ dev: true })).toContain("'unsafe-eval'");
    expect(buildCsp({})).not.toContain('unsafe-eval');
    expect(buildCsp({})).not.toContain('ws:');
  });

  it('configuration cannot inject directives or keywords', () => {
    expect(
      parseHosts("https://a.example 'unsafe-eval' http://insecure.example https://b.example;x *"),
    ).toEqual(['https://a.example']);
    expect(parseHosts('https://*.example.com https://cdn.example.com:8443')).toEqual([
      'https://*.example.com',
      'https://cdn.example.com:8443',
    ]);
  });

  it('mode defaults to enforce (fail closed)', () => {
    expect(cspMode(undefined)).toBe('enforce');
    expect(cspMode('nonsense')).toBe('enforce');
    expect(cspMode('report-only')).toBe('report-only');
  });
});
