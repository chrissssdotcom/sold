# Runbook: environments

How to create, pause, extend and destroy environments, what guards them, and how production changes. Design: [ADR-0003](../adr/0003-environments-and-upgrades.md). Vendor facts and what is still unverified: [ADR-0002](../adr/0002-azure-cloudflare.md).

> **Status.** The Terraform and the CLI are validated and unit-tested. **Nothing here has been applied to a real subscription**: the first bootstrap and `env:up` will surface vendor surprises. Steps marked _first-apply check_ are the places to watch. `PENDING(phase-0)` items are listed at the end.

## The ladder in one screen

| Environment | env-id                    | Created by                                  | Changes by                                  | Ends                                              |
| ----------- | ------------------------- | ------------------------------------------- | ------------------------------------------- | ------------------------------------------------- |
| ephemeral   | `demo-eph-<slug>-<hash4>` | `sold env:up` (label `preview`, `/preview`) | new push to the PR (same env-id, TTL reset) | TTL (48 h default, 7 d max), PR close, `env:down` |
| dev         | `demo-dev`                | `sold env:up demo dev --profile dev`        | merge to `main` (auto deploy)               | never (paused off-hours)                          |
| stage       | `demo-stage`              | `sold env:up demo stage --profile stage`    | promotion PR                                | never (paused off-hours)                          |
| prod        | `demo-prod`               | bootstrap + first promotion                 | **promotion PR only**                       | never; the CLI refuses to touch it                |

Rules that hold everywhere: every Azure resource carries the seven `sold:*` tags; every environment has its own resource group; Terraform state is per environment in the customer's own storage account; **nobody changes prod by hand**.

## One-time setup per customer

### 1. Scaffold the instance

```bash
pnpm sold customer:new acme --dir ../sold-acme --base-version 1.0.0 --display-name "Acme Pty Ltd"
```

creates `sold.config.ts`, `config/{dev,stage,prod}.ts`, `environments/{dev,stage,prod}/release.json` (placeholder digest), the Terraform roots `ops/terraform/environments/acme/{dev,stage,prod,ephemeral}`, `docs/instance/`, `.sold/base-version`, `.sold/instance.json`, and a drift workflow. Clone Base at `base-v1.0.0`, lay the scaffold over it, add the `upstream` remote (`git remote add upstream <base-repo>`). `--dry-run` lists the files.

### 2. Bootstrap (once, by a human with rights on the customer's subscriptions)

`ops/terraform/bootstrap/customer` creates: the resource group `rg-sold-acme-shared`, the **state storage account** (Entra-only, versioned, `tfstate` and `tfstate-prod` containers), the **container registry**, **three** GitHub OIDC identities (non-prod, prod, prod read-only) with federated credentials (no secrets), their role assignments, the Azure resource providers Sold needs (azurerm 5 registers none by default), and optionally the Cloudflare zone baseline (TLS, cache/rate-limit/noindex rulesets).

```bash
cd ops/terraform/bootstrap/customer
az login    # customer's tenant; Owner (or Contributor + User Access Administrator) on both subscriptions
terraform init && terraform apply \
  -var subscription_id=<nonprod-subscription> -var customer=acme -var region=australiaeast -var owner=<you> \
  -var state_storage_account_name=<globally-unique> -var registry_name=<globally-unique> \
  -var github_repository=<org>/<repo> -var nonprod_scope=/subscriptions/<nonprod> -var prod_scope=/subscriptions/<prod>
```

The bootstrap keeps **local state** (it creates the state store): keep or discard it deliberately. Its outputs feed the next step. _First-apply check_: the role assignments (`Contributor` + `Role Based Access Control Administrator` on the deploy scopes) need the operator to be allowed to assign roles; prefer a **separate production subscription** so the prod identity can never touch non-prod.

### 3. GitHub configuration

Repository **variables**: `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID_NONPROD`, `AZURE_CLIENT_ID_NONPROD`, `ACR_NAME`; for the edge `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, `SOLD_PREVIEW_DOMAIN` (e.g. `preview.acme.example`); optional `ALWAYS_ON_ENVS`, `SOLD_DEPLOY_FREEZE`, `INFRACOST_ENABLED`. Repository **secrets**: `CLOUDFLARE_API_TOKEN` (least privilege: Zone DNS/Rulesets/Waiting Room/Settings, Account Access/Turnstile/R2), `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` (R2 token with object read/write, used only to empty buckets on destroy), `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, optional `PROMOTION_TOKEN` and `INFRACOST_API_KEY`.

GitHub **environments**: `ephemeral`, `dev`, `stage` (no reviewers), `prod` (required reviewers, deployment branch `main`, variables `AZURE_SUBSCRIPTION_ID_PROD`, `AZURE_CLIENT_ID_PROD`), `prod-readonly` (variables `AZURE_SUBSCRIPTION_ID_PROD`, `AZURE_CLIENT_ID_PROD_RO`). The federated credentials created by the bootstrap match exactly these environment names (`repo:<org>/<repo>:environment:<name>`, case-sensitive). Create labels `preview`, `env-expiry`, `env-cleanup`, `terraform-drift`, `prod`, `incident`. The release workflow's **stamp** step pushes `environments/dev/release.json` to `main`: allow the Actions bot to bypass branch protection for that path, or stamp through a PR.

### 4. First environment

```bash
pnpm sold env:up acme dev --profile dev --owner <you> --dry-run     # read the plan first
pnpm sold env:up acme dev --profile dev --owner <you>
```

`dev` needs a stamped `environments/dev/release.json` (the first build). _First-apply checks_: the Origin CA certificate + Container Apps custom-domain binding (ADR-0002 item 2), Managed Redis private DNS zone name (stage/prod), PostgreSQL SKU availability in the region (`az postgres flexible-server list-skus`), and that the migrate image exists.

## Everyday operations

Every command takes `--dry-run`, which prints the exact `terraform`, `az` and API calls and executes nothing.

```bash
pnpm sold env:list                       # env-id, profile, owner, time to expiry, release (from resource-group tags)
pnpm sold env:up acme my-branch --branch feature/my-branch \
  --image <acr>/sold/web@sha256:<digest> --release-version 1.0.0+acme.12 --owner <you> --ttl 24h --seed demo
pnpm sold env:extend acme-eph-feature-my-b-1a2b --ttl 24h   # never beyond 7 days from now
pnpm sold env:pause  acme-dev            # web/worker to zero, PostgreSQL stopped (idempotent)
pnpm sold env:resume acme-dev
pnpm sold env:cost                       # month-to-date actual cost per environment
pnpm sold env:down acme-eph-feature-my-b-1a2b --verify --require-cloudflare
pnpm sold env:id --branch feature/my-branch   # what env-id a branch maps to
pnpm sold env:plan acme-stage --json-out plan.json   # read-only plan (exit 6 = has changes); also allowed for prod
```

- **Previews** from a PR: add the `preview` label or comment `/preview` (write access required). The workflow builds the branch once, creates the environment, and comments the URL. Fork PRs never get an environment. Closing the PR runs `env:down --verify`.
- **TTL**: default 48 h, minimum 1 h, maximum 7 days from now (also after extensions). At most **5** concurrent ephemeral environments per customer; the 6th `env:up` is refused and lists the existing ones.
- **`env:down --verify`** is the definition of "gone": it fails (exit 3) if Azure Resource Graph, a soft-deleted Key Vault, or Cloudflare (DNS record, R2 bucket, Access application/policy, Turnstile widget, Waiting Room) still carries or is named after the env-id. CI runs it with `--require-cloudflare` so a missing token cannot pass silently.
- **Production refusals** (no `--force` exists): `env:down|pause|resume|extend|up` refuse when the env-id contains `prod`, the resource group is tagged `sold:profile=prod`, or the repository's Terraform root sets `profile = "prod"`.

## Cost guardrails

- Ephemeral: web scales to zero, Burstable PostgreSQL, **no Redis, no Service Bus**, 0.5 GB/day log cap, a monthly budget (25 in the billing currency) with 50/80/100% and forecast alerts to the owner and the action group, TTL, nightly expiry, weekly cost report.
- Dev/stage are paused evenings and resumed mornings (`env-expire.yml`; schedules are UTC and default to Australia/Sydney; edit per customer; opt out with `ALWAYS_ON_ENVS`).
- **The Container Apps free grant (180,000 vCPU-s, 360,000 GiB-s, 2 M requests per month) is per subscription**, not per environment. The invoice therefore does not tell you what one preview cost; use `env:cost` and the tags.
- Paused is not free: PostgreSQL storage and backups, Log Analytics, Key Vault, and (stage) Managed Redis keep billing.

## Changing production

1. The build is stamped into `environments/dev/release.json` and deployed to dev automatically.
2. Run the **Release** workflow with `promote_to: stage`. It runs `sold promote dev stage` (copies `release.json`, same image digest, nothing rebuilt) and opens a PR. Merge it: stage deploys with a canary.
3. When stage is good, run **Release** with `promote_to: prod`, review the PR, merge it.
4. The `prod` job waits for **environment approval**, passes the **deploy-freeze check** (repository variable `SOLD_DEPLOY_FREEZE=true`, or windows in `environments/prod/freeze.json` such as `{"windows":[{"from":"2026-11-25T00:00:00Z","to":"2026-12-02T00:00:00Z","reason":"Black Friday"}]}`), logs in with the **production identity**, verifies the image signatures, then runs `sold release:deploy prod`.
5. `release:deploy`: new revision at **0%** traffic, **migration job** (expand/contract, forward-only) before any traffic, revision health check, then **10%, 50%, 100%** with a soak and an SLO check between steps; the previous revision is deactivated at the end.
6. **Rollback**: an SLO burn (placeholder: any Sev0-2 alert fired since the deploy began) applies `canary_percent = 0`, returning all traffic to the previous revision, fails the run and opens an incident issue. Then **revert the promotion PR** so `environments/prod/release.json` matches what serves. For a manual rollback, promote the previous release through the same PR path (`sold promote --allow-downgrade` when needed); do not `az containerapp` your way around it.
7. Emergency during a freeze: set the repository variable `PROD_FREEZE_OVERRIDE` to a written reason (at least 10 characters); the run logs it. Remove it afterwards.

## Customer operating modes

- **Platform-team-delegated.** The customer's subscription is delegated to the Sold team (Azure Lighthouse, or a service principal the customer creates and can revoke). Bootstrap, state, registry, Key Vaults and data all stay in the customer's subscription. Details of Terraform authentication across a Lighthouse delegation were not verified: **UNVERIFIED - verify before adopting**; the safe fallback is a service principal in the customer's tenant with the same role assignments the bootstrap gives the OIDC identities.
- **Customer-run.** The customer's engineers own the GitHub repository and run the same workflows; the Sold team consults.
- Either way: production changes only through a promotion PR with reviewers on the `prod` environment; the customer can freeze deploys; offboarding is deleting the delegation and the identities.

## Troubleshooting

| Symptom                                                                         | Cause and action                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `env:down --verify` exits 3 with `microsoft.keyvault/vaults` or `deletedVaults` | A soft-deleted Key Vault reserves its name. Non-prod purges on destroy; if that failed: `az keyvault purge --name <vault>` (the output prints the exact command). A prod vault has purge protection and cannot be purged before retention ends.                                                                                                                                                                    |
| `env:down --verify` reports an R2 bucket                                        | R2 will not delete a non-empty bucket. The destroy-time script needs the AWS CLI and `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` in the runner. Manually: empty it in the dashboard (Settings, Empty Bucket) or run `ops/terraform/scripts/r2-empty.sh` with `R2_ACCOUNT_ID`, `R2_BUCKET` and the keys, then `terraform destroy` again. Alternative: a 1-day lifecycle rule that expires all objects, wait, destroy. |
| `env:down --verify` reports a DNS record / Access application                   | An interrupted destroy. Delete it in Cloudflare (the object is named or commented with the env-id), or re-run `env:down`.                                                                                                                                                                                                                                                                                          |
| `no Terraform state for <env-id>`                                               | The state is gone or the environment was already destroyed. If the resource group still exists, `env:down <env-id> --delete-orphans` deletes it directly, and only if it is tagged `sold:profile=ephemeral`.                                                                                                                                                                                                       |
| `Error acquiring the state lock`                                                | A run was cancelled mid-apply. Confirm no run is active, then `terraform force-unlock <id>` in the environment's root. Workflows queue instead of cancelling to avoid this.                                                                                                                                                                                                                                        |
| Creating a Key Vault fails: name reserved                                       | Same env-id recreated within retention. The provider recovers soft-deleted vaults by default (`recover_soft_deleted_key_vaults`); if recovery is denied, purge it (above).                                                                                                                                                                                                                                         |
| Preview is unreachable from the internet (403)                                  | Cloudflare Access is on by design; the requester must match the allow-list (`access` in the root's tfvars). Previews with no `SOLD_PREVIEW_DOMAIN` have only the raw Container Apps URL and no edge.                                                                                                                                                                                                               |
| `AADSTS700213` / `AADSTS7002138` in a workflow                                  | The federated credential subject must match exactly and case-sensitively: `repo:<org>/<repo>:environment:<name>`, no numeric IDs. Compare with the `subject claim` in the run log.                                                                                                                                                                                                                                 |
| Terraform: `resource provider ... is not registered`                            | azurerm 5 registers nothing. Add the provider to `resource_providers_to_register` in the bootstrap and re-apply it.                                                                                                                                                                                                                                                                                                |
| PostgreSQL started by itself                                                    | Azure restarts a stopped flexible server after 7 days. The nightly pause re-stops it.                                                                                                                                                                                                                                                                                                                              |
| A Container Apps environment vanished                                           | Environments with no running apps or jobs for 90 days are deleted by the platform. Re-apply.                                                                                                                                                                                                                                                                                                                       |
| `release:deploy` says the prod job is required                                  | Prod is deployed only by the approved workflow job. Run the promotion PR path; there is no local override.                                                                                                                                                                                                                                                                                                         |
| Deploy stops at "migration ... did not finish" or `Failed`                      | No traffic was shifted. Read the job's logs (`az containerapp job execution list` / Log Analytics), fix forward with a new build (migrations are forward-only), and redeploy. The previous revision keeps serving.                                                                                                                                                                                                 |
| Preview build succeeds but the app cannot start                                 | The `migrate` Dockerfile target is **PENDING(phase-0)**: without it the migrate job cannot run and the database is empty. Add the target, or run migrations by hand against the preview.                                                                                                                                                                                                                           |

## Pending

- `PENDING(phase-0)`: Dockerfile `migrate` target and the `SOLD_SEED` contract for `--seed`; first apply in a sandbox subscription; measured idle/active cost per profile (record in `docs/scaling.md`).
- `PENDING(phase-4)` / `PENDING(phase-7)`: Entra token authentication for Redis and PostgreSQL (both use Key-Vault-held credentials until then).
- `PENDING(phase-8)`: SLO burn-rate alerts replacing the placeholder rollback signal; checkov/trivy findings triaged and made blocking; sale-readiness runbook (`SOLD_SCALE_MODE=prescale`, event-scale tier, Waiting Room).
