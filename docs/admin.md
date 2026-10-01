# Admin API and console

The console (`/admin`) and the API it calls (`/api/admin/*`) are staff-only. Both enforce the same checks; the UI hiding a button is a convenience, never the control.

## API

Every route is `adminRoute(permission, handler)` (`apps/web/src/server/admin-route.ts`). Order of checks: same-origin (CSRF) → staff session → `can()` →
handler. Handlers whose permission depends on the body (going live, cancelling, fulfilling) call `requireCan` as well. Responses are `private, no-store`.

| Area         | Routes                                                                                        | Permission                                                      |
| ------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Dashboard    | `GET /dashboard`                                                                              | `reports:read`                                                  |
| Products     | `GET/POST /products`, `GET/PATCH /products/:id`                                               | `catalog:read/write`; **active** needs `catalog:publish`        |
| Stock, price | `PUT /variants/:id/stock`, `PUT /variants/:id/price`                                          | `catalog:write`                                                 |
| Orders       | `GET /orders`, `GET /orders/:id`, `POST /orders/:id/transition`                               | `orders:read`; `orders:write` + `orders:fulfil`/`orders:cancel` |
| Payments     | `POST /payments/:id/refund`, `POST /payments/:id/confirm`                                     | `payments:refund`; `orders:write`                               |
| Pages        | `GET/POST /pages`, `GET/PUT/PATCH /pages/:id`, `POST /pages/:id/publish                       | unpublish`, `GET /blocks`                                       | `content:read/write`; publish needs `content:publish` |
| Promotions   | `GET/POST /promotions`, `PATCH /promotions/:id`                                               | `promotions:read/write`                                         |
| Theme        | `GET/PUT /theme`                                                                              | `theme:read/write`                                              |
| Staff        | `GET/POST /users`, `PATCH /users/:id`, `PUT/DELETE /users/:id/roles/:role`, `GET/POST /roles` | `users:read/write/roles`                                        |
| Audit        | `GET /audit`                                                                                  | `audit:read`                                                    |

Conventions: errors are `{ error: { code, message, details? } }`; validation failures are 422 with `details.issues`; lists are keyset-paginated
(`before`, `nextCursor`) and bounded; refunds require a client-supplied idempotency key (the console rotates it only after success, so a retry after a
timeout replays instead of refunding twice); page saves take `expectedVersion` and return 409 on a concurrent edit; theme saves are versioned the same way.

Page **saving never changes what is live**. It appends an immutable version. Publishing (or rolling back) is a separate, separately permissioned pointer move.

## Console

Server components render each screen (permission checked on the server, `notFound`/redirect otherwise); small client components call the API.
It has its own root layout and stylesheet (`app/admin/admin.css`): no markup or CSS is shared with the storefront.

**Page builder** (`/admin/pages/:id`): block list/tree, add (into the selected container or at the end), move, duplicate, delete, a props form
**generated from the block's JSON Schema** (the same Zod schema that validates saves, via `GET /api/admin/blocks`), version history with
preview and rollback, desktop/mobile preview. The preview is the real storefront page rendered by the active theme at
`/<locale>/preview/:pageId`, visible to signed-in staff only (404 otherwise), never cached, never indexed.

Limitations (honest):

- The preview refreshes on **save**, not on each keystroke; there is no drag-and-drop (move buttons only) and no undo/redo beyond reloading a version.
- Blocks contributed by a _theme_ (`extraBlocks`) validate in the API (which loads the theme) but admin pages themselves use the schema-only registry.
- Product create/edit covers one variant at creation; further variants/options are not editable in the console yet. No media library (Phase 7).
- Promotions UI creates percent-off and free-shipping only; the API accepts every definition kind.
- Theme editor covers a curated token set (colours, radii) with an AA contrast check; fonts and layout are theme code.
- Axe checks pass on every screen; that is not a full accessibility audit (no screen-reader testing was done).

## Tests

`apps/web/e2e/admin-api.e2e.ts` (HTTP: authn, CSRF, permission matrix, writes, audit), `admin-ui.e2e.ts` (Chromium: axe light/dark on all screens,
builder round trip, CSS-isolation guard), `account.e2e.ts`. They need a running server and an owner:

```bash
pnpm sold user:create-owner --email e2e@example.test        # note the password
SOLD_E2E_URL=http://localhost:3000 SOLD_E2E_OWNER_EMAIL=e2e@example.test SOLD_E2E_OWNER_PASSWORD=… pnpm --filter @sold/web test:e2e
```
