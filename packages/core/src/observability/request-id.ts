import { randomUUID } from 'node:crypto';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

/** Accept an inbound request ID only if it is well-formed; otherwise mint one. */
export function resolveRequestId(inbound: string | null | undefined): string {
  return inbound && SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID();
}
