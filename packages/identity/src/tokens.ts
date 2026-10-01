import { createHash, randomBytes } from 'node:crypto';

/** 256 bits from the OS CSPRNG, URL-safe. */
export const newToken = (): string => randomBytes(32).toString('base64url');

/** What is stored: a token's SHA-256. A database leak yields nothing that can be replayed as a cookie or bearer token. */
export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
