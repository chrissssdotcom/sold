# Notifications (email)

`packages/notify` is durable outbound email. Orders and sign-ups queue mail in Postgres; a worker loop sends it.

```
order.placed / order.status_changed ──outbox relay──▶ notifyOnEvent ──▶ notifications (queued)
register route ─────────────────────────────────────────────────────────▶ notifications (queued)
worker loop ── deliverDue (SKIP LOCKED, leased) ──▶ EmailTransport (Postmark | SMTP | Console)
```

## Guarantees (and what is _not_ guaranteed)

- **Idempotent enqueue.** One logical email = one `dedupe_key` (`<event id>:<template>`, `welcome:<user id>`). The outbox relay is at-least-once, so the
  same event arrives more than once; only the first queues an email. Tested, including through the real `relayOutbox`.
- **At-least-once delivery, not exactly-once.** A row is leased (`sending`) while a worker sends. If the worker dies after the provider accepted the message
  but before we recorded it, the lease expires and the message is sent again. `Message-ID` (SMTP) and `X-Idempotency-Key` (Postmark) are derived from the
  dedupe key so duplicates are recognisable. Exactly-once would need provider-side dedupe we cannot assume.
- **Bounded retries.** Transient failures back off (30 s doubling to 1 h, with jitter) up to 8 attempts, then `failed`. A permanent failure (SMTP 5xx, provider 4xx
  other than 429) fails immediately. `failed` and long-`queued` rows show on the admin dashboard.
- **Suppression.** Addresses in `email_suppressions` are never mailed, transactional mail included (sending to bounced addresses hurts deliverability for everyone).
  Nothing populates it automatically yet: there is no bounce/complaint webhook handler (see gaps).
- **Safe templates.** Data is validated against the template's Zod schema **at enqueue**, links must be http(s), every interpolated value is HTML-escaped, and
  subjects cannot carry newlines. Tested with hostile names and product titles.
- **Many workers are fine** (`FOR UPDATE SKIP LOCKED`; tested with 8 concurrent deliverers over 40 messages: each exactly once).

## Configuration

| Variable                | Meaning                                                                     |
| ----------------------- | --------------------------------------------------------------------------- |
| `POSTMARK_SERVER_TOKEN` | Use Postmark (wins if both are set)                                         |
| `SMTP_URL`              | e.g. `smtp://user:pass@host:587` (Mailpit locally: `smtp://localhost:1025`) |
| `EMAIL_FROM`            | `Name <address>`; must be authorised for the provider (SPF/DKIM/DMARC)      |
| `SOLD_PUBLIC_URL`       | Origin used in links (orders, account)                                      |

With no provider configured: `local` and `ephemeral` log each email (`ConsoleTransport`); every other environment **queues and does not send**, and warns at
worker boot, so mail is never silently discarded or pretend-sent.

## Templates

`order-confirmation`, `order-shipped`, `order-cancelled`, `order-refunded`, `welcome`, plus `review-request` and `abandoned-cart` (for lifecycle automation).
Add one in `templates.ts`: a Zod schema, a `subject`, and a structured `body` (heading, paragraphs, rows, call-to-action). HTML and text are both generated
from it, so they cannot disagree. The look is one neutral layout in `render()`; a deployment that wants its own replaces it there.

## Verified vs not

- Verified: queue semantics against real Postgres (12 integration tests); SMTP against a minimal local SMTP server; Postmark against a local fake of its
  documented API; end to end locally (register and check out through the web app, the worker logs the emails, rows end `sent`).
- **Not verified:** real delivery to a mailbox (no provider credentials here), rendering across mail clients (Outlook, Gmail dark mode), Postmark's actual error codes.
  Send a test order through your provider and look at it in a few clients before launch.

## Rollout warning

Enabling this on an instance that already has **unpublished** outbox events will email for them (the relay publishes the backlog; this happened in local testing
and sent "cancelled" emails for old test orders). New installs are unaffected. On an existing instance, check
`SELECT count(*) FROM outbox_events WHERE published_at IS NULL` first and mark old ones published if you do not want those emails.

## Gaps

- No unsubscribe/preferences for marketing mail: only transactional templates exist; lifecycle emails must stay opt-in when they ship.
- No bounce/complaint ingestion into `email_suppressions`.
- Templates are English; money formats with `en-AU`. Order links use the first market's slug.
