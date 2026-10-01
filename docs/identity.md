# Identity, sessions and access control

`packages/identity` owns users, credentials, sessions, roles, SSO and provisioning. It depends on `@sold/commerce` only for the shared
error type and on `@sold/db`. Nothing in it knows about HTTP; `apps/web/src/server/{identity,admin-route,sso*}.ts` is the thin adapter.

## Two kinds of user, never mixed

|                          | Customers                       | Staff                     |
| ------------------------ | ------------------------------- | ------------------------- |
| Cookie                   | `sold_session` (Lax)            | `sold_admin` (**Strict**) |
| Idle / absolute lifetime | 30 d / 90 d                     | 2 h / 12 h                |
| Sign-in                  | email + password                | password, OIDC, SAML      |
| Reach                    | storefront and `/api/account/*` | `/admin`, `/api/admin/*`  |

A customer session is rejected by every admin route (tested). Outside local the cookies use the `__Host-` prefix and `Secure`.

## Credentials and sessions

- scrypt (N=2^15, r=8, p=3) with a per-user salt; parameters are stored in the hash, so raising them rehashes transparently at next login.
- Password policy: length first (12+), a small block list, and no email-in-password. No composition rules.
- Session tokens are 256-bit random; **only their SHA-256 is stored**, so a database read cannot be replayed as a session.
- **Permissions are computed from roles at every request**, never cached in the session. Removing a role or disabling an account takes
  effect on the next request. Disabling deletes the user's sessions.
- Login failures are indistinguishable (same message, same work: a dummy hash is verified for unknown accounts).
- Throttling is keyed on the account and (when a trusted proxy supplies it) the client address, hashed, with an atomic upsert and an escalating lock.
  Set `SOLD_TRUST_PROXY=1` only behind Cloudflare/Front Door, otherwise the client address is unknown and throttling keys on the account alone.

## Authorisation

One primitive: `can(permissions, needed)`. Grants may use `*` or `area:*`; a _check_ must name a specific permission (`orders:*` as a
requirement is refused, which stops a typo becoming "everyone passes"). Base permissions are in `rbac.ts`; extensions add theirs.
Built-in roles: `owner` (`*`), plus the roles seeded by migration. Custom roles can never contain `*`.

The last active owner cannot be disabled, demoted or removed (checked under `FOR UPDATE`, tested with concurrent attempts).

## Audit log

`audit_log` is append-only (a trigger rejects UPDATE/DELETE). Every admin write records actor, action, target, detail and IP, in the same
transaction as the change where the service owns the transaction. **Not hash-chained yet** (the original plan asked for it); the trigger prevents
ordinary tampering but not a superuser rewriting the table.

## SSO

- **OIDC**: authorization code + PKCE (S256), discovery with issuer match, ID-token algorithm allow-list, `state`/`nonce`/`aud`/`exp` checks, JWKS via `jose`.
- **SAML 2.0 SP**: assertions must be signed; `InResponseTo` is bound to a sealed, HttpOnly request cookie; recipient, audience, `IssueInstant` age and
  `NotOnOrAfter` are enforced; assertion IDs go in a replay ledger (`sso_replay`). The SAML cookie is `SameSite=None; Secure` because the IdP posts cross-site.
- **Provisioning rules** (`completeSsoLogin`): link by (provider, subject); link by email only when the IdP says it is verified _and_ the operator opted in;
  never touch customers or disabled accounts; map IdP groups to roles; **never grant `owner` from a group**.
- **SCIM 2.0** (`/scim/v2`): staff only, groups are roles, DELETE deactivates, bearer token stored hashed.

Configure in `sold.config.ts` under `identity` (`oidc`, `saml`, `scim`); secrets come from the environment, never the config file.

### What has and has not been verified

Everything above is tested against **local fake IdPs** that implement the protocols (`fake-idp.ts`, `fake-saml-idp.ts`), including forged signatures,
wrong audience, expired and replayed assertions, and tampered state. **It has not been run against Keycloak, Entra ID or Okta.** Before enabling SSO in
production, run the flow against your real IdP in a non-production environment and confirm claim names (`email_verified`, group claim) match your config.

## Operating it

```bash
pnpm sold user:create-owner --email you@example.com   # prints a generated password once
```

Sweeps that need a worker schedule (not wired yet): `SessionService.sweepExpired`, `SamlClient.sweep` (replay ledger). Until then expired rows are
ignored by every query but accumulate.

## CSRF

Cookie-authenticated, state-changing requests must carry an `Origin` (or `Referer`) matching the host and a JSON content type (`server/csrf.ts`), on top of
SameSite cookies. The storefront's cart/checkout endpoints rely on SameSite=Lax cart cookies and do not yet check `Origin`; add `assertSameOrigin` there before
exposing the storefront under a different cookie policy.
