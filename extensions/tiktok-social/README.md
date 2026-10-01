# tiktok-social

Tiktok Social

Scaffolded by `pnpm sold ext:new tiktok-social`. Everything here is yours to change: an instance's customisations live in
`extensions/` and `sold.config.ts`, never in Base files.

## Enable it

1. `pnpm install` (links the new workspace package).
2. Add `'tiktok-social'` to `extensions` in `sold.config.ts`.
3. `pnpm sold ext:sync && pnpm db:migrate` (or just `pnpm dev`, which does both locally).

## What is in it

| File                           | Contribution                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `src/index.ts`                 | the manifest: it wires the pieces below together                               |
| `src/settings.ts`              | the settings schema (becomes an admin form)                                    |
| `src/record-order.observer.ts` | an observer: reacts to `order.placed`, asynchronously, with retries            |
| `src/hello.route.ts`           | an API route mounted at `/x/tiktok-social/hello`                               |
| `migrations/0001_init.sql`     | its own table, `ext_tiktok_social_events` (extensions never touch Base tables) |
| `src/index.test.ts`            | a unit test that runs the route handler and the observer                       |

File names matter: the lint rule reads them. `*.interceptor.ts` (cart/checkout interceptors) must be pure, with no network,
filesystem or process access. `*.observer.ts`, `*.job.ts` and `*.route.ts` may use I/O; every other file is strict too.
Third-party libraries go in this package's `dependencies` and are importable from the I/O files only.

Rules that keep upgrades boring: depend only on `@sold/extension-sdk`; name every table `ext_tiktok_social_*`; declare
`performance.hotPath` honestly; keep interceptors free of I/O. See `docs/extending.md`.
