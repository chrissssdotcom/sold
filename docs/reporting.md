# Reporting and dashboards

Business reporting reads a **separate, read-only, PII-free schema**, never Base tables.

```
Grafana ──(role sold_grafana, read-only, 30 s timeout)──▶ reporting.* views ──(owner privileges)──▶ Base tables
```

## The `reporting` schema (migration `0013`)

| View                  | What it answers                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `daily_sales`         | Revenue-bearing orders per UTC day and currency: orders, units, subtotal, discounts, shipping, tax, total (+ exact `total_minor`) |
| `order_funnel`        | For orders placed each day: placed / paid / awaiting payment / cancelled / refunded                                               |
| `top_products_30d`    | Units and revenue per product, last 30 days                                                                                       |
| `inventory_health`    | On hand, reserved, available, `low_stock` (≤ 5) for active products                                                               |
| `payments_by_gateway` | Payment counts and amounts by gateway, status, currency (captured, refunded)                                                      |
| `refunds_daily`       | Refunds per day by currency and status                                                                                            |
| `new_customers_daily` | Sign-ups per day (a count; never who)                                                                                             |
| `email_queue`         | Outbound email by status and the age of the oldest unsent message                                                                 |

Money is shown in decimal major units using the currency's exponent (`reporting.major(amount, currency)`: JPY 0, KWD 3, most 2), next to the exact minor-unit column where it
matters. **Currencies are never summed together**: every money view carries its currency.

### Guarantees (all tested, as the reporting role, against a real database)

- The role can `SELECT` from `reporting.*` and **nothing else**: `orders`, `users`, `sessions`, `payments`, `notifications`, `audit_log`, `extension_settings` are all "permission denied".
- It cannot write, create, alter or drop anything; it is not superuser/createrole/createdb; `default_transaction_read_only = on`; `statement_timeout = 30s`;
  `idle_in_transaction_session_timeout = 10s`.
- **No reporting column can carry personal data**: a test scans every column name for email/address/phone/IP/token/secret/customer or user id/actor/session/cart id.
- The numbers are checked against orders created in the test: a paid order appears with the exact total; an unpaid one does not.

### Operating it

```bash
pnpm db:migrate                                   # creates the schema, views and the role (NOLOGIN, no password)
GRAFANA_DB_PASSWORD=... pnpm sold reporting:enable-login   # sets the login password out of band (>= 20 chars outside local)
```

Point Grafana's "Sold Reporting" datasource at a **replica** in deployed environments (Section 8A.4). Locally compose uses the primary; the password in `docker-compose.yml` is
`sold_grafana`, so run the second command with that value.

Views are plain, not materialised: simple and always correct. If one gets slow at your volume, materialise that view and refresh it from a worker job. Not measured here at scale.

## Dashboards (`ops/grafana/dashboards`, provisioned as code)

- **Scale & Capacity** (Prometheus): RED metrics by route class, saturation, queue depth, and the other signals in `docs/scaling.md`.
- **Sales & Operations** (reporting schema): revenue, orders, awaiting payment, low stock, daily revenue and funnel, top products, payments by gateway, refunds, new customers, email queue.

A test loads every dashboard JSON, expands the Grafana macros, and **runs every SQL panel as `sold_grafana`**, asserting each reads only `reporting.*`. Not verified: the dashboards
rendering in Grafana itself (Grafana is not available in this environment).

## Extension reporting views

An extension may declare `reportingViews: [{ name, description, sql }]`. `sold ext:migrate` creates `reporting.ext_<extension>_<name>`, grants `SELECT` to the reporting role, and drops
views of extensions that are disabled or no longer declare them. Because a view runs with its owner's privileges, the SQL is **parsed and restricted**: exactly one plain `SELECT`
(CTEs allowed), reading **only the extension's own tables** (`ext_<name>_*`), and no file/OS/session/catalogue functions. A view that breaks the rules is skipped and reported; it never blocks
the others. To report on Base data, copy the (non-personal) facts you need into your own tables from an observer. You are responsible for what your own tables contain: do not put emails in a
table you expose to reporting.
