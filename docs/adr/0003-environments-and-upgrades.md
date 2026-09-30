# ADR-0003: Environments, release pipeline and Base upgrades

- Status: Accepted
- Date: 2026-09-30
- Deciders: Sold engineering (Platform/SRE)

## Context

One deployment serves one business (ADR-0001). Each customer therefore needs the same environment ladder, a way to make cheap disposable previews, a release path where **the artifact that was tested is the artifact that ships**, and a way to take Base upgrades without merge pain. Vendor facts behind these choices are in ADR-0002. This ADR is the operating model; `docs/runbooks/environments.md` and `docs/upgrading.md` are the procedures.

## Decisions

### 1. The environment ladder is data

| Profile     | Purpose                             | Lifetime                                  | Redis / Service Bus | Database                    | Safety switches (`safetySwitchesFor`)                   | Protection                                                                                                           |
| ----------- | ----------------------------------- | ----------------------------------------- | ------------------- | --------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `ephemeral` | PR preview, feature spike           | TTL 48 h default, 7 d max, then destroyed | no / no             | Burstable, no HA            | Stripe test, email capture, sinks, noindex, no real PII | Cloudflare Access; own resource group; budget alert                                                                  |
| `dev`       | shared integration, auto-deployed   | permanent, paused off-hours               | no / no             | Burstable, no HA            | same                                                    | Access                                                                                                               |
| `stage`     | production-shaped rehearsal, canary | permanent, paused off-hours               | yes / optional      | tier SKU, zone-redundant HA | same                                                    | Access; runs the **same tier** as prod                                                                               |
| `prod`      | customers                           | permanent                                 | yes / optional      | tier SKU, zone-redundant HA | production values                                       | `CanNotDelete` lock, `prevent_destroy`, Key Vault purge protection, prod-only identity, approval gate, deploy freeze |

`ops/terraform/profiles/*.tfvars` hold `profile_settings` (per rung) and `tier_settings` (per `standard | high-volume | event-scale`: replicas, CPU/memory, dedicated workload profile, PostgreSQL SKU/HA/replicas/PITR, Redis SKU, Service Bus SKU). The `sold-environment` module contains **no `if profile == "prod"`** beyond consuming these values, so environments differ by configuration, never by code path (AGENTS.md principle 9). Tier files apply to stage and prod; ephemeral and dev carry their own small capacity. The capacity numbers are **starting assumptions** and follow the replica ranges in `docs/scaling.md`; they become facts only after the Phase 8 load tests.

### 2. Identity, tags, layout

- **env-id** `<customer>-<environment>`: `demo-dev`, `demo-stage`, `demo-prod`, `demo-eph-<slug>-<hash4>` (slug of the branch, hash of the raw branch name, so the same branch always maps to the same environment and `feature/A` never collides with `feature-a`). Customer is 3-12 alphanumerics with no hyphen so ids parse unambiguously; the id is at most 40 characters.
- **Every Azure resource carries seven tags**: `sold:customer`, `sold:environment`, `sold:profile`, `sold:owner`, `sold:expires-at` (RFC 3339 or `never`), `sold:release`, `sold:env-id`. One `locals` map in the composite feeds every module; every module also validates the tag map it receives; `ops/terraform/scripts/check-tags.ts` fails a CI plan if any taggable `azurerm_*` resource lacks one (taggable = the planned object has a `tags` attribute, so unknown resource types cannot slip through). `env:down --verify` relies on the env-id tag.
- **One resource group per environment** (`rg-sold-<env-id>`), so destroying an environment is one deletion and leftovers are visible as a non-empty group. Container Apps' managed infrastructure group is named `rg-sold-<env-id>-aca` and dies with the environment.
- **State**: one state per environment in the **customer's own** storage account (Entra auth only, versioned, delete-locked, separate `tfstate-prod` container). Ephemeral environments share one root and pass `-backend-config=key=ephemeral/<env-id>.tfstate`; the root exposes an `inputs` output so `pause`, `resume`, `extend` and `down` can re-apply without the original command line.
- **Names that must be unique across Azure** get a subscription-derived suffix. Key Vault names (24 characters) are `kv-<first 14 alphanumerics of the env-id>-<6-char hash>`, so they include the env-id.

### 3. Guardrails for stateful and production resources

- `lifecycle { prevent_destroy = true }` cannot be conditional, so PostgreSQL, Key Vault and the R2 bucket exist as **two resource blocks selected by `count`** (`protected` and `unprotected`); the composite passes `protect_stateful` from the profile. Flipping the flag on a live environment moves the resource between addresses and needs `terraform state mv`, which is the intended friction. Redis and Service Bus hold no system of record and are not duplicated.
- Production additionally gets an Azure `CanNotDelete` lock on the resource group.
- Key Vault: non-prod `purge_soft_delete_on_destroy = true` (name released at once); prod purge protection, 90-day retention, and the provider never purges.
- The CLI has **no override** for production: `env:down`, `env:pause`, `env:resume`, `env:extend` and `env:up` refuse when the name contains `prod`, the resource group is tagged `sold:profile=prod`, or the repository's Terraform root sets `profile = "prod"`.
- **R2**: Cloudflare refuses to delete a non-empty bucket and the v5 provider has no force option. Non-prod buckets get a destroy-time `local-exec` that runs `ops/terraform/scripts/r2-empty.sh` (S3 API, needs the AWS CLI and an R2 API token in the runner environment, refuses bucket names not starting `sold-`). If a runner cannot do that, expire everything with a 1-day lifecycle rule and destroy after it drains. Prod buckets are never emptied automatically.
- **Budgets and alerts** exist per environment (Azure consumption budget with 50/80/100% actual and 100% forecast notifications, an ingestion-capped Log Analytics workspace, 5xx and database CPU alerts).

### 4. Lifecycle and cost control of ephemeral environments

- TTL: default 48 h, minimum 1 h, **maximum 7 days from now, including after extensions**. The TTL is stamped as `sold:expires-at` by Terraform.
- Guard: at most **5** concurrent ephemeral environments per customer (`--max-concurrent` to change); re-running `env:up` for an existing environment is an update.
- `env-expire.yml`: nightly warning issue 24 h before expiry, then verified destruction of expired environments; only `profile = ephemeral` is selected. `env-down.yml` destroys on PR close and **fails if anything carrying the env-id remains** (Azure Resource Graph, soft-deleted Key Vaults, Cloudflare DNS/R2/Access/Turnstile/Waiting Room).
- Pause (dev/stage, evenings): web and worker scale to zero through Terraform (`paused = true`), PostgreSQL is stopped with `az`. Azure restarts a stopped PostgreSQL server after 7 days, so pausing is re-run nightly and is idempotent. Managed Redis cannot be stopped.
- The Container Apps monthly free grant is shared per subscription, so previews should live in a subscription whose only cost is previews' own; the weekly cost report and budgets are the guardrails.

### 5. Release model: build once, promote the digest

- CI builds each Docker target **once per commit**, pushes to the customer's ACR, signs each image with **Sigstore keyless** (bound to `release.yml@refs/heads/main`), and attaches an SPDX **SBOM as a signed attestation**. Every deploy job verifies the signature before touching Azure (`ops/terraform/scripts/verify-release-signatures.sh`).
- `environments/<env>/release.json` is the only per-environment release record: `{ baseVersion, instanceBuild, imageDigest, extensionVersions, terraformModuleVersion }` (+ optional `workerImageDigest`, `migrateImageDigest`; see deviations). It is validated by a Zod schema; JSON Schemas are generated into `.sold/schemas/`.
- **Version identifier** `<base-version>+<customer>.<instance-build>` (SemVer build metadata), e.g. `1.4.0+demo.27`; it is baked into the image (`SOLD_VERSION`), stamped on resources (`sold:release`) and used as the git tag / PR title.
- Dev is stamped by the release workflow (`sold release:stamp`, the only writer of `environments/dev/release.json`). **`sold promote <from> <to>` copies the file forward one rung** (dev to stage to prod); it refuses to skip a rung, to downgrade, or to promote a placeholder digest, and the workflow opens the PR. Merging the PR is the deployment trigger. Prod changes only that way.
- `sold release:deploy <env>` is the only deploy path (pipeline and laptop alike): verify the release, create the new **Container Apps revision at 0% traffic** (Multiple revision mode; Terraform variables `canary_percent`, `previous_revision_suffix`), run the **expand/contract migration job before any traffic shifts**, wait for the revision to be healthy, then 10%, 50%, 100% with a soak and an **SLO check** between steps. A failed check applies `canary_percent = 0` (traffic returns to the previous revision) and fails the run; the promotion PR must then be reverted so git matches what serves. Where there is no previous revision to protect (first deploy, or Single-revision dev), the migrate job is updated and run first with a targeted apply, then everything is rolled out. The SLO signal is a **placeholder** (any Sev0-2 Azure Monitor alert fired since the deploy began, failing closed); real multi-window burn-rate alerts are PENDING(phase-8).
- The **`prod` job** is bound to the GitHub environment `prod` (required reviewers, `main` only), uses a **separate Azure identity** whose federated credential subject is `repo:<org>/<repo>:environment:prod`, runs the **deploy-freeze check** before any cloud access (`SOLD_DEPLOY_FREEZE=true` repository variable, or windows in `environments/prod/freeze.json`; an emergency override needs a written reason, which is logged), and the CLI refuses to deploy prod unless that job set `SOLD_DEPLOY_APPROVED=prod`.
- Drift: `terraform.yml` runs a nightly **read-only** plan of every environment (prod with a dedicated read-only identity and `-lock=false`), enforces the tag policy on the plan, and opens or updates an issue on drift. The plan JSON can contain sensitive values and is never uploaded.

### 6. Base upgrades

- The repository pins Base in **`.sold/base-version`**; Base publishes tags `base-v<semver>` and a `CHANGELOG.md` whose entries carry tags: `- [breaking] ...`, `[migration]`, `[infra]`, `[security]` (several per bullet allowed).
- **`.sold/base-manifest.json`** lists Base-owned, customer-owned and generated paths (precedence generated, base, customer). Base-owned paths are replaced from upstream on upgrade and must not be edited in an instance; customer-owned paths are never touched.
- `sold upgrade:check` (available releases, tagged changes, **extension compatibility** from each extension's `sold.requires.base` semver range using the `semver` package; extensions that declare nothing are `unknown`, never compatible), `sold upgrade:plan <version> [--patch-only]` (branch `upgrade/base-v<version>`, take upstream for Base-owned paths from the **target release's** manifest, remove retired files, run every `upgrades/<version>/*.ts` codemod for releases in `(current, target]`, write `docs/instance/upgrades/<version>.md`, commit), `sold upgrade:apply` (verification gates: install, typecheck, lint, tests, migration lint; optional push; the PR is opened by workflow).
- **`sold drift:check`** fails a PR that changes Base-owned paths outside an `upgrade/*` branch. It reads the manifest from the **base ref**, so a PR cannot un-own the files it edits, and it does nothing unless `.sold/instance.json` exists (Base edits its own paths).
- Extension `requires.base` is read from `package.json` (`"sold": { "requires": { "base": "..." } }`) until the extension SDK defines the manifest contract (PENDING(phase-1)).

### 7. Customer operating modes

- **Platform-team-delegated**: the customer's subscription is managed by the Sold team through **Azure Lighthouse** (or a service principal the customer creates). Pipelines and state still live in the customer's subscription and storage account; the customer keeps offboarding control.
- **Customer-run**: the customer's engineers run the pipelines in their own GitHub organisation.
- In both modes production changes only through a promotion PR, deploy freeze applies, and the customer's own subscription, state and registry hold everything. Neither mode changes the code.

### 8. CLI surface and exit codes

`env:up|id|plan|pause|resume|extend|list|cost|down`, `customer:new`, `upgrade:check|plan|apply`, `drift:check`, `promote`, `release:stamp|deploy|version|freeze-check`; `data:snapshot` and `content:export|import` are Phase 0 stubs that exit 5. Every command accepts `--dry-run`, which prints the exact `terraform` / `az` / `git` / Cloudflare requests and executes nothing (read-only guard queries still run, failing soft). Exit codes are stable: 0 ok, 1 failure, 2 usage, 3 leftovers found by `--verify`, 4 refused by a guard, 5 not implemented, 6 the plan has changes.

## Deviations from the specification

1. `release.json` has two optional fields beyond the specified five (`workerImageDigest`, `migrateImageDigest`) because the Dockerfile builds separate targets. With neither, the web image is used for all roles.
2. Environment roots take `canary_percent` / `previous_revision_suffix` / `drift_reader_object_id` for the pipeline; canary traffic is therefore Terraform-managed rather than `az containerapp ingress traffic set`.
3. Cloudflare zone rulesets are customer-level, not per environment (one entry-point ruleset per phase per zone; ADR-0002).
4. Migration-before-traffic in first-deploy and Single-revision cases uses a targeted apply (`-target`) of the migrate job. It is deliberate and documented; it is not used elsewhere.
5. `env:extend` re-applies with the stored inputs instead of patching tags, so Terraform stays the single source of truth.

## Implementation status (honest)

| Area                                                                                 | State                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Terraform modules, composite, profiles, roots, bootstrap                             | **Validated** (`terraform validate`, `fmt`, offline `terraform test` with mock providers, and `tofu validate/test`) with the real providers. **Never applied and never planned** against a subscription |
| Tag policy script                                                                    | Implemented, unit-tested on fixture plans; not yet run on a real plan                                                                                                                                   |
| CLI (`env:*`, `customer:new`, `upgrade:*`, `drift:check`, `promote`, `release:*`)    | Implemented and unit-tested with the process runner mocked; upgrade/drift tested against real temporary git repositories                                                                                |
| GitHub workflows                                                                     | Written and linted with `actionlint`; **never run**. Actions are pinned by commit SHA (resolved from the repositories' tags on 2026-09-30)                                                              |
| Azure / Cloudflare / az / Cost Management / Alerts API response shapes               | Coded against documented shapes; **UNVERIFIED** against live services                                                                                                                                   |
| `migrate` Dockerfile target, DB seed contract (`SOLD_SEED`), Entra token auth in DBs | PENDING(phase-0) / PENDING(phase-7)                                                                                                                                                                     |
| Real SLO burn-rate rollback signal                                                   | PENDING(phase-8) (placeholder in place)                                                                                                                                                                 |
| Idle/active cost per profile                                                         | PENDING (needs a subscription)                                                                                                                                                                          |

## Consequences

- A new customer is `sold customer:new`, a bootstrap apply and repository variables, not a project.
- Everything an operator does to an environment is a CLI command that a pipeline also calls, so it can be rehearsed with `--dry-run`.
- The ownership manifest makes "we never edit Base" mechanically checkable, but only in instance repositories and only for paths listed in it. Keep it current with every new Base directory.
- The ephemeral model depends on Terraform state being reachable to re-apply or destroy; `env:down --delete-orphans` exists for the case where it is not, and is restricted to resource groups tagged ephemeral.

## Open items

- First real apply in a sandbox subscription, and converting the UNVERIFIED items in ADR-0002 to verified.
- `migrate` image target and the seed contract.
- SLO burn-rate alerts and the rollback signal; measured cost; k6 gates in the promotion workflow.
- Optional: run `terraform test` for the modules in the pull-request workflow against a real sandbox (currently mock-provider only).
