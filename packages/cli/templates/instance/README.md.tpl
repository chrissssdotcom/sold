# {{name}} (Sold instance)

This repository is a Sold **instance**: Sold Base plus this customer's extensions.

- Customer-owned (edit freely): `extensions/`, `sold.config.ts`, `config/<env>.ts`, `environments/`,
  `ops/terraform/environments/{{customer}}/`, `docs/instance/`.
- Base-owned (never edit; replaced on upgrade): everything else. See `.sold/base-manifest.json`.
- Base version: `.sold/base-version`. Upgrade with `pnpm sold upgrade:check` then `pnpm sold upgrade:plan <version>`.
- Environments: `pnpm sold env:up {{customer}} <name>`. Production changes only through a promotion PR.

`pnpm sold drift:check` fails when Base-owned paths change outside an `upgrade/*` branch (CI runs it on every PR).
