import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing with scrypt (built into Node: no native addon to build or patch). Parameters follow OWASP's
 * guidance (N=2^15, r=8, p=3 as the memory/time trade-off) and are stored with each hash, so raising them later
 * upgrades users transparently at their next login (`needsRehash`).
 */
export interface PasswordParams {
  N: number;
  r: number;
  p: number;
}
export const defaultPasswordParams: PasswordParams = { N: 2 ** 15, r: 8, p: 3 };

const KEY_LEN = 64;
const MAXMEM = 256 * 1024 * 1024;

const derive = (password: string, salt: Buffer, params: PasswordParams): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const opts: ScryptOptions = { N: params.N, r: params.r, p: params.p, maxmem: MAXMEM };
    scrypt(password.normalize('NFKC'), salt, KEY_LEN, opts, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });

export async function hashPassword(
  password: string,
  params: PasswordParams = defaultPasswordParams,
): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

function parse(hash: string): { params: PasswordParams; salt: Buffer; key: Buffer } | null {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(hash);
  if (!m) return null;
  const params = { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]) };
  // Bound what a (tampered or legacy) stored hash can make us spend.
  if (params.N < 2 ** 12 || params.N > 2 ** 20 || params.r > 16 || params.p > 16) return null;
  return {
    params,
    salt: Buffer.from(m[4] as string, 'base64url'),
    key: Buffer.from(m[5] as string, 'base64url'),
  };
}

/** Constant-time verification. A malformed stored hash verifies as false, never throws. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const parsed = parse(hash);
  if (!parsed) return false;
  const key = await derive(password, parsed.salt, parsed.params);
  return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
}

export function needsRehash(hash: string, target: PasswordParams = defaultPasswordParams): boolean {
  const parsed = parse(hash);
  if (!parsed) return true;
  const { N, r, p } = parsed.params;
  return N < target.N || r < target.r || p < target.p;
}

let dummy: Promise<string> | undefined;
/** A real hash to verify against when the account does not exist, so "no such user" costs the same time as "wrong password". */
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword('not-a-real-password-sold');
  return dummy;
}

const COMMON = new Set([
  'password',
  'password1',
  'password123',
  '1234567890',
  'qwertyuiop',
  'letmein123',
  'iloveyou12',
  'welcome123',
  'admin12345',
  'changeme123',
  'passw0rd123',
  '0123456789',
  'abcdefghij',
  'qwerty12345',
  '1q2w3e4r5t',
]);

export interface PolicyResult {
  ok: boolean;
  reason?: string;
}

/**
 * NIST 800-63B style: length over composition rules. At least 10 characters, at most 128 (bounds hashing cost),
 * not a trivially common password, not containing the account email's local part.
 */
export function checkPasswordPolicy(
  password: string,
  context: { email?: string } = {},
): PolicyResult {
  if (password.length < 10) return { ok: false, reason: 'Use at least 10 characters.' };
  if (password.length > 128) return { ok: false, reason: 'Use at most 128 characters.' };
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(password))
    return { ok: false, reason: 'That password is too common.' };
  const local = context.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local))
    return { ok: false, reason: 'Do not include your email name in your password.' };
  return { ok: true };
}
