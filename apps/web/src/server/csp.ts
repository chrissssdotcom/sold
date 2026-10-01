/**
 * Content-Security-Policy (ADR-0005). Edge-safe: no Node imports, because `proxy.ts` uses it on every request.
 *
 * Two postures, chosen by path:
 *  - Staff console (`/admin`): dynamic, so every response gets a fresh nonce and scripts need it (`'strict-dynamic'`).
 *  - Storefront: ISR/CDN-cached HTML cannot carry a per-request nonce, so scripts are same-origin plus inline (Next's
 *    bootstrap) plus an explicit allowlist of third parties an extension needs (e.g. the TikTok pixel). Everything that is
 *    not script still gets the strict rules: no framing by others, no `<base>` hijack, no plugins, forms only to us.
 */
export interface CspOptions {
  /** Fresh per request; presence selects the strict (console) posture. */
  nonce?: string;
  /** Extra script/connect hosts, from `SOLD_CSP_SCRIPT_HOSTS` / `SOLD_CSP_CONNECT_HOSTS` (space separated origins). */
  scriptHosts?: string[];
  connectHosts?: string[];
  /** Next's dev server needs eval for React refresh. Never true in production. */
  dev?: boolean;
}

const ORIGIN = /^https:\/\/[a-z0-9.*-]+(:\d+)?$/i;

/** Only well-formed https origins survive: config cannot smuggle `'unsafe-eval'` or a second directive in. */
export function parseHosts(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .filter((h) => ORIGIN.test(h));
}

export function buildCsp(opts: CspOptions = {}): string {
  const script = opts.nonce
    ? ["'self'", `'nonce-${opts.nonce}'`, "'strict-dynamic'"]
    : ["'self'", "'unsafe-inline'", ...(opts.scriptHosts ?? [])];
  if (opts.dev) script.push("'unsafe-eval'");
  const connect = ["'self'", ...(opts.connectHosts ?? []), ...(opts.dev ? ['ws:', 'wss:'] : [])];
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': script,
    'style-src': ["'self'", "'unsafe-inline'"], // inline style attributes (theme tokens, page-builder spacing)
    'img-src': ["'self'", 'data:', 'blob:', 'https:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': connect,
    'frame-src': ["'self'"],
    'frame-ancestors': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
  };
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ');
}

export type CspMode = 'enforce' | 'report-only' | 'off';

export function cspMode(raw: string | undefined): CspMode {
  return raw === 'report-only' || raw === 'off' ? raw : 'enforce';
}

export const cspHeaderName = (mode: CspMode) =>
  mode === 'report-only' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
