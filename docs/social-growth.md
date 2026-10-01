# Social and growth (Phase 6)

What exists, what each piece guarantees, and what was **not** verified. Nothing here has talked to TikTok, a mail provider or a real browser fleet.

## Cookie consent (Base)

- A banner mounted by the storefront shell (`ConsentBanner`) so every theme gets it; style the `.consent*` classes (the default theme ships them).
- **Nothing optional runs before a choice.** The default is "no". "Reject optional" and "Accept all" are the same size, in the same row; "Choose" opens per-category toggles
  (measurement, advertising). A footer button ("Cookie preferences") reopens it. Re-asked after six months.
- **Global Privacy Control** (`navigator.globalPrivacyControl`) is honoured: the choice is recorded as `gpc`, advertising stays off, no banner. A `gpc` record can never
  carry marketing consent, even if forged into the cookie (the server re-checks).
- The record is a first-party cookie `sold_consent` (`{a, m, t, s}`); malformed, oversize or expired values mean _no consent_.
- Base publishes the current choice at `window.__sold.consent` and fires `sold:consent`, so extension browser code can read it without importing Base.
- **The choice is stored with each order** (`orders.consent`, from the cookie on the server, never from the request body: a body that tries to claim consent is rejected with 422).
  `order.placed` carries `marketingConsent`. Server-side marketing events must check the order's record, not the cookie of a later visit.
- Storefront events (`sold:event`: `view_item`, `add_to_cart`, `purchase`) are emitted for extensions to consume; amounts are minor-unit strings.

Not done: a consent log/export for audits beyond the per-order record; per-vendor granularity; a consent-management certification. This is a sound technical baseline, **not legal advice**:
confirm the wording and categories with your counsel for each market you sell in.

## TikTok (`extensions/tiktok-social`)

- **Pixel** (browser): loaded only after advertising consent; sends `ViewContent`, `AddToCart`, `PlaceAnOrder` (event id `order-<id>`).
- **Events API** (server): off by default. When enabled with an access token, sends `PlaceAnOrder` (same event id as the browser, so TikTok counts the pair once) and `CompletePayment`
  (`payment-<id>`), **only for orders whose recorded consent includes advertising**. The email is SHA-256 hashed after normalisation and never sent in clear. Retries on 5xx/429/network;
  a 4xx rejection is logged and dropped (retrying cannot succeed); a sent-ledger table makes our side idempotent.
- **Blocks**: `tiktok-social/follow-banner` (a plain link) and `tiktok-social/video-embed` (placeholder until advertising consent, then TikTok's embed iframe).
- Settings (Admin > Extensions > tiktok-social): pixel code, server events switch, access token (encrypted, write-only), test event code, store URL. Changes reach running workers within ~15-20 s.

Verified: payload shape and hashing against a known SHA-256 vector, the consent gate (all negative cases), idempotency and error classification in 7 unit tests against a local fake; the
**whole path locally** (settings API → order with consent cookie → outbox → worker → observer → fake TikTok): the consenting order produced exactly one call with the token in the header and a hashed
email; the order without consent produced none. In Chromium: no request to `tiktok.com` before a choice or after "Reject"; the pixel script is requested after "Accept all"; GPC keeps it off.

**Not verified:** anything against TikTok itself. The pixel bootstrap and the Events API request/response shapes are written from TikTok's documentation as I know it and must be checked in
Events Manager ("Test events", using the test event code) before relying on them. The embed iframe URL form likewise. Treat all three as unconfirmed until then.

## Reviews (`extensions/reviews`)

See `extensions/reviews/README.md`. Verified-buyer only, one per customer per product, moderation by default, escaped output. Limits: client-rendered (not seen by non-JS crawlers), no
`aggregateRating` in structured data, no photos/replies/votes.

## Lifecycle email

- **Review request** (`notifications.reviewRequestDays` in `sold.config.ts`, default 0 = off): N days after an order is marked delivered, one delayed email links to the product page(s). Enable it with the
  `reviews` extension. Idempotent per event; tested through the real queue.
- **Abandoned-cart email is deliberately not built.** It is marketing mail to someone who has not bought; it needs a recorded opt-in per customer (and unsubscribe), which accounts do not have yet.
  Building it without that would be a compliance problem, not a feature.

## Gaps for this phase

Search (`SearchProvider`), SMS/push, referral and loyalty programmes beyond the example extension, A/B testing hooks, and an unsubscribe/preferences centre are not built.
