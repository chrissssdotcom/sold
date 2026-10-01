# ADR-0005: Content-Security-Policy

Status: accepted · Phase 8

## Decision

`apps/web/src/proxy.ts` sets a CSP on every response, built by `server/csp.ts`, with two postures:

| Surface                        | `script-src`                                                        | Why                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Staff console (`/admin/**`)    | `'self' 'nonce-<per request>' 'strict-dynamic'`                     | Always dynamic, handles the most sensitive session; a stored-XSS bug here is the worst case, so inline script is not allowed. |
| Storefront (everything else)   | `'self' 'unsafe-inline'` + hosts from `SOLD_CSP_SCRIPT_HOSTS`       | HTML is ISR/CDN-cached and shared between visitors: a per-request nonce would either break caching or be reused (useless). |

All other directives are strict on both: `default-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`,
`frame-ancestors 'self'` (the page-builder preview frames our own origin), `img-src 'self' data: blob: https:` (merchant images
may be hosted elsewhere), `connect-src 'self'` plus `SOLD_CSP_CONNECT_HOSTS`.

Third parties are opt-in per deployment, not baked in: an operator who enables the TikTok extension sets
`SOLD_CSP_SCRIPT_HOSTS=https://analytics.tiktok.com` and `SOLD_CSP_CONNECT_HOSTS=https://analytics.tiktok.com`. Values are parsed to
well-formed `https://host[:port]` origins only, so configuration cannot inject keywords such as `'unsafe-eval'`.

`SOLD_CSP=enforce|report-only|off` (default **enforce**; an unknown value also enforces). `report-only` exists so an operator adding a
new third party can watch before enforcing.

## Consequences

- Storefront script injection is **not** fully contained by CSP (`'unsafe-inline'`). The mitigations are upstream: output escaping,
  the block schema (Zod) that rejects unknown props, no HTML-string props in the default theme, and the extension trust model (ADR-0004).
  Moving the storefront to hash-based CSP needs build-time hashing of Next's inline bootstrap and is deliberately deferred.
- Dev adds `'unsafe-eval'` and websockets (React refresh); production never does (unit-tested).
- The `/media/*` route keeps its own `default-src 'none'` + `nosniff` (uploaded images can never execute).
- No `report-uri` endpoint yet: violations are visible in browser consoles and CDN logs only.

## Verified

Unit tests for the builder; e2e loads the storefront and five console pages in Chromium and fails on any CSP violation or page
error; e2e asserts the nonce differs per request on the console and is absent on the storefront. **Not verified:** a production
(`next start`) build under CSP: only the dev server has been exercised, and production scripts are the ones that must carry the nonce.
