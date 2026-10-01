# Changelog

Sold Base releases. `pnpm sold upgrade:check` reads this file from the release tag: a bullet that starts with tags
(`[breaking]`, `[migration]`, `[infra]`, `[security]`) is surfaced to instance owners before they upgrade; untagged bullets are ordinary changes.
Procedure for cutting a release: `docs/upgrading.md#publishing-side-for-base-maintainers`.

**No Base release has been cut yet.** `Unreleased` is what the first one will contain. When you tag it, rename the heading to
`## <version> - <YYYY-MM-DD>`, bump `BASE_VERSION` in `packages/core/src/version.ts`, and tag `base-v<version>`.

## Unreleased

- [migration] 0011-0015 add notifications, per-order consent, the `reporting` schema, public API/webhook tables and media assets. All additive (new tables/columns); the previous release's own e2e suite passes on this schema (`ops/drills/n-minus-1.sh`).
- [migration][infra] Production mode enforces per-extension database roles: run `NODE_ENV=production pnpm db:migrate` (or the release `migrate` job) so `sold_ext_*` roles exist before web/worker start; `SOLD_EXTENSION_DB_SECRET` is required.
- [infra] New optional environment variables: `SOLD_CSP` (`enforce`|`report-only`|`off`), `SOLD_CSP_SCRIPT_HOSTS`, `SOLD_CSP_CONNECT_HOSTS`, `SOLD_CSP_FRAME_HOSTS`, `SOLD_SHED_BELOW`, `SMTP_URL`, `POSTMARK_SERVER_TOKEN`, `EMAIL_FROM`, `SOLD_PUBLIC_URL`.
- [breaking] A Content-Security-Policy is now sent. Third-party scripts (for example the TikTok pixel) are blocked until the operator allowlists their hosts via `SOLD_CSP_SCRIPT_HOSTS` / `SOLD_CSP_CONNECT_HOSTS` / `SOLD_CSP_FRAME_HOSTS` (ADR-0005).
- [breaking] The theme contract gained required `AuthPage` and `AccountPage`, and slots; custom themes must implement them.
- [security] Same-origin (CSRF) checks compare `Origin` with the `Host` header and `SOLD_PUBLIC_URL`; releases before this refused every cookie-authenticated write when the server bound `HOSTNAME=0.0.0.0` (the container default).
- [security] `sharp` 0.35.5 (two high advisories in libvips/libheif); `pnpm audit --prod` is clean.
- [security] Every `/api/admin` and `/api/v1` route is verified to sit behind its authorisation wrapper by a test that fails CI for new unwrapped routes.
- [infra] Alert rules in `ops/prometheus/alerts.yml`; Prometheus must load them (`rule_files`).
- Worker bundle fixed: it crashed at boot after the reporting views landed (lazy `createRequire`).
- Dependency outages now answer `503` + `Retry-After` instead of `500`.
- Load shedding by route class (`shed.*` flags, `SOLD_SHED_BELOW`); checkout and probes are never shed.
- Admin console, customer accounts, notifications, reviews and TikTok extensions, consent, reporting, public API with webhooks, media library, feature flags, Redis job queue adapter.
