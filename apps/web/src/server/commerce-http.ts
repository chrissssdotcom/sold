import { CommerceError } from '@sold/commerce';
import { InvalidTreeError } from '@sold/content';
import { ZodError } from 'zod';

export class BodyTooLargeError extends Error {}
export class BadJsonError extends Error {}

/**
 * Read a JSON body with a hard byte limit enforced while streaming (Content-Length is advisory and can be absent or
 * a lie, so it is never trusted on its own).
 */
export async function readJson(request: Request, maxBytes = 64 * 1024): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new BodyTooLargeError();
  if (!request.body) throw new BadJsonError();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BadJsonError();
  }
}

/** JSON with bigint amounts as decimal strings: a JS number cannot carry all minor-unit values exactly. */
export function json(body: unknown, init?: ResponseInit): Response {
  return new Response(
    JSON.stringify(body, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
    { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } },
  );
}

/** Map domain and input errors to stable machine-readable responses. Anything else is rethrown (500, no leak). */
export function errorResponse(error: unknown): Response {
  if (CommerceError.is(error)) {
    // Lockouts tell the client when to come back.
    const retry = (error as { retryAfterSeconds?: number }).retryAfterSeconds;
    return json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      },
      { status: error.status, ...(retry ? { headers: { 'retry-after': String(retry) } } : {}) },
    );
  }
  if (error instanceof ZodError)
    return json(
      {
        error: {
          code: 'validation_failed',
          message: 'Invalid request',
          details: {
            issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          },
        },
      },
      { status: 422 },
    );
  if (error instanceof InvalidTreeError)
    return json(
      { error: { code: error.code, message: error.message, details: { issues: error.issues } } },
      { status: 422 },
    );
  if (error instanceof BodyTooLargeError)
    return json(
      { error: { code: 'payload_too_large', message: 'Request body too large' } },
      { status: 413 },
    );
  if (error instanceof BadJsonError)
    return json(
      { error: { code: 'invalid_json', message: 'Body must be valid JSON' } },
      { status: 400 },
    );
  throw error;
}
