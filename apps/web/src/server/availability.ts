/**
 * Is this error "a dependency is unreachable" (retry soon) rather than "our code is wrong"? Drizzle wraps driver errors in
 * `Failed query: ...` with the real error on `cause`, so the whole chain is walked. Query timeouts (57014) and constraint violations are
 * deliberately NOT here: those are not outages.
 */
const CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now (starting up / recovering)
  '53300', // too_many_connections
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
]);
const MESSAGE =
  /connection terminated|timeout exceeded when trying to connect|the database system is (starting up|shutting down|in recovery)|connection refused|server closed the connection/i;

export function isDependencyUnavailable(error: unknown): boolean {
  let e: unknown = error;
  for (let depth = 0; depth < 6 && e && typeof e === 'object'; depth++) {
    const { code, message, cause, errors } = e as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (typeof code === 'string' && CODES.has(code)) return true;
    // `Failed query: ... params: ...` embeds user data and the SQL; only the cause's own message is trusted.
    if (typeof message === 'string' && !message.startsWith('Failed query') && MESSAGE.test(message))
      return true;
    // AggregateError (Node's happy-eyeballs connect failures) carries the codes on its members.
    if (Array.isArray(errors) && errors.some((x) => isDependencyUnavailable(x))) return true;
    e = cause;
  }
  return false;
}
