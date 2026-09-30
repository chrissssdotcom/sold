# __NAME__

__TITLE__

Scaffolded by `pnpm sold ext:new __NAME__`. Everything here is yours to change: an instance's customisations live in
`extensions/` and `sold.config.ts`, never in Base files.

## Enable it

1. `pnpm install` (links the new workspace package).
2. Add `'__NAME__'` to `extensions` in `sold.config.ts`.
3. `pnpm sold ext:sync && pnpm db:migrate` (or just `pnpm dev`, which does both locally).

## What is in it

| File | Contribution |
|---|---|
| `src/index.ts` | the manifest: settings, a permission, an API route, and an observer |
| `migrations/0001_init.sql` | its own table, `__PREFIX__events` (extensions never touch Base tables) |
| `src/index.test.ts` | a unit test that runs the route handler and the observer |

Rules that keep upgrades boring: depend only on `@sold/extension-sdk`; name every table `__PREFIX__*`; declare
`performance.hotPath` honestly; keep interceptors free of I/O. See `docs/extending.md`.
