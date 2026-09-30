import { pino, type Logger } from 'pino';

/**
 * Keys whose values are never logged, at any depth and in any casing/separator style
 * (`accessToken`, `client_secret`, `x-api-key`, `Set-Cookie`, ...). Matching is on the normalised key
 * (lower-cased, separators removed), so new spellings of a known-sensitive name are caught automatically.
 */
const SENSITIVE_KEY =
  /(password|passwd|secret|token|apikey|authorization|cookie|credential|privatekey|signature|sessionid|cardnumber|cvv|cvc|iban|ssn|taxid|dob|dateofbirth)/;
/** Personal data: redacted by key (an email is PII even when it is not a credential). */
const PII_KEY =
  /^(email|emailaddress|phone|phonenumber|mobile|address|shippingaddress|billingaddress|street|postcode|zip|firstname|lastname|fullname)$/;

const normaliseKey = (k: string) => k.toLowerCase().replaceAll(/[^a-z0-9]/g, '');

export const REDACTED = '[redacted]';
const MAX_DEPTH = 8;

/** Credentials embedded in text: `scheme://user:pass@host`, `Bearer xxx`, `sk_live_...`, long hex/base64 secrets in `key=value`. */
export function scrubString(value: string): string {
  return value
    .replaceAll(/(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, `$1${REDACTED}@`)
    .replaceAll(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, `Bearer ${REDACTED}`)
    .replaceAll(/\b(?:sk|pk|rk|whsec)_(?:live|test)_[A-Za-z0-9]{8,}/g, REDACTED)
    .replaceAll(
      /((?:password|passwd|secret|token|apikey|api_key|authorization)\s*[=:]\s*)[^\s,;&"']+/gi,
      `$1${REDACTED}`,
    );
}

/** Deep, cycle-safe redaction of a log payload. Returns a new value; the input is never mutated. */
export function redactDeep(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[truncated]';
  seen.add(value);
  if (value instanceof Error) {
    const out: Record<string, unknown> = { type: value.name, message: scrubString(value.message) };
    if (value.stack) out.stack = scrubString(value.stack);
    for (const [k, v] of Object.entries(value))
      if (!(k in out)) out[k] = redactKeyed(k, v, depth, seen);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1, seen));
  if (value instanceof Date || Buffer.isBuffer(value))
    return value instanceof Date ? value : '[binary]';
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = redactKeyed(k, v, depth, seen);
  return out;
}

function redactKeyed(key: string, value: unknown, depth: number, seen: WeakSet<object>): unknown {
  const n = normaliseKey(key);
  if (SENSITIVE_KEY.test(n) || PII_KEY.test(n)) return REDACTED;
  return redactDeep(value, depth + 1, seen);
}

/** Kept for callers/tests that inspect the shallow path list; the real protection is `redactDeep`. */
export const redactPaths = [
  'password',
  'token',
  'secret',
  'authorization',
  'cookie',
  'email',
  'phone',
  'address',
];

export interface LoggerOptions {
  level?: string;
  service: string;
  version?: string;
  environment?: string;
  /** Destination stream (default: stdout). Injectable for tests. */
  stream?: NodeJS.WritableStream;
}

export function createLogger(opts: LoggerOptions): Logger {
  return pino(
    {
      level: opts.level ?? 'info',
      base: { service: opts.service, version: opts.version, environment: opts.environment },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
        // Every log object passes through deep redaction, including nested objects, arrays and Error values.
        log: (object) => redactDeep(object) as Record<string, unknown>,
      },
      serializers: { err: (e: unknown) => redactDeep(e) },
    },
    opts.stream,
  );
}

export type { Logger };
