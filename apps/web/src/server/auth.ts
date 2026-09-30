import { timingSafeEqual } from 'node:crypto';

/** Constant-time bearer token check. Returns false when no token is configured (fail closed). */
export function bearerMatches(header: string | null, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice('Bearer '.length));
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}
