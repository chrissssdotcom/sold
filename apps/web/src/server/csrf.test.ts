import { describe, expect, it } from 'vitest';
import { assertSameOrigin, CsrfError } from './csrf';

const req = (method: string, headers: Record<string, string> = {}, body?: string) =>
  new Request('https://shop.example/api/admin/x', {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
  });
const refused = (r: Request) => {
  try {
    assertSameOrigin(r);
    return false;
  } catch (e) {
    expect(e).toBeInstanceOf(CsrfError);
    return true;
  }
};

describe('assertSameOrigin', () => {
  it('lets safe methods through', () => {
    expect(refused(req('GET'))).toBe(false);
    expect(refused(req('HEAD'))).toBe(false);
  });
  it('accepts a same-origin JSON write', () => {
    expect(
      refused(
        req('POST', { origin: 'https://shop.example', 'content-type': 'application/json' }, '{}'),
      ),
    ).toBe(false);
  });
  it('accepts a same-origin bodyless DELETE and action POST (browsers send no content type)', () => {
    expect(refused(req('DELETE', { origin: 'https://shop.example' }))).toBe(false);
    expect(refused(req('POST', { origin: 'https://shop.example' }))).toBe(false);
  });
  it('refuses a cross-site origin, even with JSON', () => {
    expect(
      refused(
        req('POST', { origin: 'https://evil.example', 'content-type': 'application/json' }, '{}'),
      ),
    ).toBe(true);
    expect(refused(req('DELETE', { origin: 'https://evil.example' }))).toBe(true);
  });
  it('refuses a missing Origin unless the browser says same-origin', () => {
    expect(refused(req('POST', { 'content-type': 'application/json' }, '{}'))).toBe(true);
    expect(
      refused(
        req('POST', { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, '{}'),
      ),
    ).toBe(false);
    expect(
      refused(
        req('POST', { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, '{}'),
      ),
    ).toBe(true);
  });
  it('refuses a form-encoded body, which a plain HTML form can send', () => {
    expect(
      refused(
        req(
          'POST',
          { origin: 'https://shop.example', 'content-type': 'application/x-www-form-urlencoded' },
          'a=1',
        ),
      ),
    ).toBe(true);
    expect(
      refused(req('POST', { origin: 'https://shop.example', 'content-type': 'text/plain' }, 'a=1')),
    ).toBe(true);
  });
  it('refuses a garbage Origin', () => {
    expect(
      refused(req('POST', { origin: 'not a url', 'content-type': 'application/json' }, '{}')),
    ).toBe(true);
  });
});
