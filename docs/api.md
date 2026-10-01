# Public API and webhooks

## API (`/api/v1`)

OpenAPI 3.1 document: `GET /api/v1/openapi.json` (public). It is generated from the same Zod schemas the routes use, and a test fetches real responses and checks them against it.

| Method and path                      | Scope           | Notes                                                                                                                                                                           |
| ------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /products`, `GET /products/:id` | `catalog:read`  | Active products with variants and prices (minor units as strings). Cursor-paginated (`limit` ≤ 50, `cursor`). One query per product on the list: fine at 50, not a bulk export. |
| `GET /orders`, `GET /orders/:id`     | `orders:read`   | Newest first; `status`, `limit`, `before`. Includes the customer email: treat an `orders:read` key as sensitive.                                                                |
| `PUT /variants/:id/stock`            | `catalog:write` | Set on-hand; cannot drop below what open orders reserved.                                                                                                                       |

**Authentication** is `Authorization: Bearer sk_<prefix>_<secret>` and nothing else. Cookies are never read, so a signed-in browser cannot be used to call the API cross-site.
Keys are created in the console (Developers) with explicit scopes (no `*`, no `area:*`), an optional expiry, and are **shown once**: only a SHA-256 of the 256-bit secret is stored. Revocation is immediate.
Every authentication failure returns the same `401` (malformed, unknown, wrong secret, revoked, expired). Keys are rate limited at 600 requests a minute (`429` + `Retry-After`; `X-RateLimit-*` on every response); the counter lives in Redis when
configured, otherwise in process (accurate for one instance, generous across many). If the limiter itself fails, requests are allowed (the platform's load shedding still applies).

Not built: write endpoints beyond stock, per-key rate configuration, key rotation with overlap, IP allow-lists, an SDK.

## Webhooks

Console > Developers > Webhooks. Events: `order.placed`, `order.status_changed`, `payment.captured`, `cart.updated`, `page.published`, `page.unpublished`.

- **Envelope:** `{ "id": "<event id>", "type": "...", "createdAt": "...", "data": { ... } }` (money amounts are strings).
- **Signature:** header `Sold-Signature: t=<unix>,v1=<hex>` where `v1 = HMAC-SHA256(secret, "<t>.<raw body>")`. Verify against the **raw** bytes, compare in constant time, and reject a `t` older than a few minutes (replay).
  The signing secret (`whsec_...`) is shown once and stored encrypted under the instance key.
- **Delivery is at least once.** Dedupe on the event `id` (or `Sold-Delivery`). One delivery row per (endpoint, event) is queued exactly once even though the outbox relay can repeat an event.
- **Retries:** 2xx = delivered; 5xx, 408, 429 and network errors back off (20 s tripling to 6 h, jittered) up to 10 attempts; any other 4xx is treated as a refusal and not retried. Delivery order is not guaranteed.
- **Safety (SSRF):** endpoints must be `https://` with no embedded credentials (plain http and private targets are allowed only in `local`). Private, loopback, link-local, cloud-metadata (169.254.169.254), CGNAT, multicast and IPv4-mapped IPv6
  addresses are refused **at connect time** by our own DNS lookup, so a hostname that later resolves inward (DNS rebinding) is still refused. No redirects are followed, the response body is never read, 10 s timeout.

Tested: signature recomputed by an independent HMAC in the test, idempotent queueing under redelivery, retry/backoff and permanent-failure behaviour, no duplicate sends under 6 concurrent workers, strict-policy refusal of a private destination,
and a live local run (order placed through the web app → outbox → worker → receiver got the events). **Not verified:** delivery to a real third-party receiver over TLS, behaviour behind an egress proxy.
