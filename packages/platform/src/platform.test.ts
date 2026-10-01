import { describe, expect, it } from 'vitest';
import { MemoryCounters, checkRate } from './rate-limit';
import { isForbiddenAddress, validateWebhookUrl } from './ssrf';
import { sign } from './webhooks';

describe('SSRF address policy', () => {
  it('refuses private, loopback, link-local, metadata, CGNAT, multicast and mapped forms', () => {
    for (const a of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '198.18.0.1',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      'fc00::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:a9fe:a9fe',
      '64:ff9b::1',
      'not-an-ip',
    ])
      expect(isForbiddenAddress(a), a).toBe(true);
  });
  it('allows ordinary public addresses', () => {
    for (const a of [
      '93.184.216.34',
      '8.8.8.8',
      '172.15.0.1',
      '172.32.0.1',
      '2606:4700:4700::1111',
      '::ffff:8.8.8.8',
    ])
      expect(isForbiddenAddress(a), a).toBe(false);
  });
  it('URL rules: https only, no credentials, no literal private hosts', () => {
    const strict = { allowPrivate: false };
    expect(validateWebhookUrl('https://hooks.example.com/x', strict)).toBeNull();
    for (const u of [
      'http://hooks.example.com',
      'https://user:pw@hooks.example.com',
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'https://169.254.169.254/latest',
      'https://localhost/x',
      'https://db.internal/x',
      'ftp://x.example.com',
      'javascript:alert(1)',
      'nonsense',
    ])
      expect(validateWebhookUrl(u, strict), u).not.toBeNull();
    expect(validateWebhookUrl('http://127.0.0.1:9000/x', { allowPrivate: true })).toBeNull();
  });
});

describe('signing', () => {
  it('is HMAC-SHA256 over "<t>.<body>" and changes with any input', () => {
    const a = sign('whsec_x', '{"a":1}', 1700000000);
    expect(a).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(sign('whsec_x', '{"a":1}', 1700000001)).not.toBe(a);
    expect(sign('whsec_x', '{"a":2}', 1700000000)).not.toBe(a);
    expect(sign('whsec_y', '{"a":1}', 1700000000)).not.toBe(a);
  });
});

describe('rate limiting', () => {
  it('allows up to the limit per window, then says when to retry, and resets next window', async () => {
    const store = new MemoryCounters();
    const t0 = 1_000_000_000_000;
    for (let i = 0; i < 5; i++) expect((await checkRate(store, 'k', 5, 60, t0)).allowed).toBe(true);
    const over = await checkRate(store, 'k', 5, 60, t0 + 1000);
    expect(over.allowed).toBe(false);
    expect(over.retryAfterSeconds).toBeGreaterThan(0);
    expect(over.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect((await checkRate(store, 'other', 5, 60, t0)).allowed).toBe(true); // per key
    expect((await checkRate(store, 'k', 5, 60, t0 + 61_000)).allowed).toBe(true); // next window
  });
  it('fails open when the counter store is down', async () => {
    const down = { incr: async () => Promise.reject(new Error('redis down')) };
    expect((await checkRate(down, 'k', 5)).allowed).toBe(true);
  });
});
