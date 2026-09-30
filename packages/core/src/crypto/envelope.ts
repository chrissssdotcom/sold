import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for stored credentials (Section 8). Each value gets its own random data key (DEK);
 * the DEK is wrapped by a root key (KEK) held outside the database (Key Vault in deployed environments,
 * `SOLD_SECRET_KEY` locally). Rotating the KEK re-wraps DEKs without touching values; a leaked DB dump
 * alone decrypts nothing.
 *
 * Token: `sold1.<keyId>.<wrapIv>.<wrappedDek+tag>.<dataIv>.<data+tag>` (base64url segments).
 * `context` is authenticated (AES-GCM AAD), so a ciphertext copied to another field or extension fails.
 */
export interface RootKey {
  id: string;
  key: Buffer;
}

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

const b64 = (b: Buffer) => b.toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url');

export function rootKeyFromBase64(base64: string): RootKey {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) throw new Error('Root key must be 32 bytes, base64 encoded');
  return { id: createHash('sha256').update(key).digest('hex').slice(0, 8), key };
}

function seal(key: Buffer, plaintext: Buffer, aad: Buffer): { iv: Buffer; sealed: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, sealed: Buffer.concat([ct, cipher.getAuthTag()]) };
}

function open(key: Buffer, iv: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  if (sealed.length < 16 || iv.length !== 12) throw new DecryptionError('Malformed ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  try {
    return Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.length - 16)),
      decipher.final(),
    ]);
  } catch {
    // Wrong key, tampering and wrong context all look the same on purpose.
    throw new DecryptionError('Decryption failed');
  }
}

export class EnvelopeCrypto {
  private readonly keys = new Map<string, Buffer>();

  /** `current` encrypts; `previous` keys remain able to decrypt during rotation. */
  constructor(
    private readonly current: RootKey,
    previous: readonly RootKey[] = [],
  ) {
    this.keys.set(current.id, current.key);
    for (const p of previous) this.keys.set(p.id, p.key);
  }

  encrypt(plaintext: string, context: string): string {
    const dek = randomBytes(32);
    const data = seal(dek, Buffer.from(plaintext, 'utf8'), Buffer.from(context));
    const wrapped = seal(this.current.key, dek, Buffer.from(`kek:${this.current.id}`));
    return [
      'sold1',
      this.current.id,
      b64(wrapped.iv),
      b64(wrapped.sealed),
      b64(data.iv),
      b64(data.sealed),
    ].join('.');
  }

  decrypt(token: string, context: string): string {
    const parts = token.split('.');
    if (parts.length !== 6 || parts[0] !== 'sold1')
      throw new DecryptionError('Unrecognised ciphertext format');
    const [, keyId, wrapIv, wrapped, dataIv, data] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const kek = this.keys.get(keyId);
    if (!kek) throw new DecryptionError(`No root key available for key id ${keyId}`);
    const dek = open(kek, unb64(wrapIv), unb64(wrapped), Buffer.from(`kek:${keyId}`));
    return open(dek, unb64(dataIv), unb64(data), Buffer.from(context)).toString('utf8');
  }

  /** True when the token was wrapped by a key other than the current one (re-encrypt on next write). */
  needsRotation(token: string): boolean {
    return token.split('.')[1] !== this.current.id;
  }
}
