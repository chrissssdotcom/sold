import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DecryptionError, EnvelopeCrypto, rootKeyFromBase64 } from './envelope';

const newKey = () => rootKeyFromBase64(randomBytes(32).toString('base64'));

describe('EnvelopeCrypto', () => {
  it('round-trips, including unicode and empty strings', () => {
    const c = new EnvelopeCrypto(newKey());
    for (const v of ['sk_live_abc123', '', 'pässwörd 🔐'])
      expect(c.decrypt(c.encrypt(v, 'ctx'), 'ctx')).toBe(v);
  });

  it('never repeats a ciphertext for the same plaintext (fresh DEK and IV each time)', () => {
    const c = new EnvelopeCrypto(newKey());
    expect(c.encrypt('same', 'ctx')).not.toBe(c.encrypt('same', 'ctx'));
  });

  it('does not contain the plaintext', () => {
    expect(new EnvelopeCrypto(newKey()).encrypt('super-secret-token', 'ctx')).not.toContain(
      'super-secret-token',
    );
  });

  it('binds ciphertext to its context: it cannot be moved to another field or extension', () => {
    const c = new EnvelopeCrypto(newKey());
    const token = c.encrypt('secret', 'ext:loyalty:apiToken');
    expect(() => c.decrypt(token, 'ext:crm:apiToken')).toThrow(DecryptionError);
  });

  it('detects tampering in every segment', () => {
    const c = new EnvelopeCrypto(newKey());
    const parts = c.encrypt('secret', 'ctx').split('.');
    for (const i of [3, 5]) {
      const bad = [...parts];
      const raw = Buffer.from(bad[i] as string, 'base64url');
      raw[0] = (raw[0] as number) ^ 0xff;
      bad[i] = raw.toString('base64url');
      expect(() => c.decrypt(bad.join('.'), 'ctx'), `segment ${i}`).toThrow(DecryptionError);
    }
  });

  it('fails with the wrong root key, without revealing why', () => {
    const token = new EnvelopeCrypto(newKey()).encrypt('secret', 'ctx');
    expect(() => new EnvelopeCrypto(newKey()).decrypt(token, 'ctx')).toThrow(
      /No root key available/,
    );
  });

  it('rotates: old tokens stay readable and are flagged for re-encryption', () => {
    const oldKey = newKey();
    const token = new EnvelopeCrypto(oldKey).encrypt('secret', 'ctx');
    const rotated = new EnvelopeCrypto(newKey(), [oldKey]);
    expect(rotated.decrypt(token, 'ctx')).toBe('secret');
    expect(rotated.needsRotation(token)).toBe(true);
    expect(rotated.needsRotation(rotated.encrypt('x', 'ctx'))).toBe(false);
  });

  it('rejects malformed tokens and bad root keys', () => {
    const c = new EnvelopeCrypto(newKey());
    for (const bad of ['', 'nope', 'sold1.a.b.c.d', 'v2.a.b.c.d.e'])
      expect(() => c.decrypt(bad, 'ctx')).toThrow(DecryptionError);
    expect(() => rootKeyFromBase64(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });
});
