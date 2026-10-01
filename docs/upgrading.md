# Upgrading an instance to a new Sold Base version

An instance is **Sold Base plus the customer's own paths**. The customer never edits Base files, so a Base upgrade is "replace the Base-owned files with the new release, run the release's codemods, prove nothing broke, promote". This document is the procedure. The design is in [ADR-0003](adr/0003-environments-and-upgrades.md).

## Status: what exists today

| Step                                                                                    | State                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ownership manifest, `.sold/base-version`, `sold drift:check`                            | **Implemented, unit-tested** (real temporary git repositories)                                                                                                                                                                                       |
| `sold upgrade:check`, `upgrade:plan`, `upgrade:apply`                                   | **Implemented, unit-tested** (real git, process runner mocked for codemods and gates)                                                                                                                                                                |
| Extension compatibility from `sold.requires.base`                                       | **Implemented**; the manifest field is read from `package.json` until the extension SDK defines the contract (PENDING(phase-1))                                                                                                                      |
| Base publishing side (`base-v<x.y.z>` tags, tagged `CHANGELOG.md`, `upgrades/<x.y.z>/`) | **Convention defined; `CHANGELOG.md` now exists (`Unreleased`)**; no Base release has been cut. **Rehearsed locally** against a tagged scratch upstream: `customer:new` → `upgrade:check` → `upgrade:plan` → `upgrade:apply` (see "Rehearsal" below) |
| Workflow that opens the upgrade PR on push of `upgrade/*`                               | PENDING: `upgrade:apply --push` pushes the branch; opening the PR from `docs/instance/upgrades/<version>.md` is left to the workflow/human                                                                                                           |
| Automated preview, dev, stage, prod promotion of the upgrade                            | **Written, never run** (`env-up.yml`, `release.yml`); needs a subscription                                                                                                                                                                           |
| Codemods                                                                                | Mechanism implemented and tested; **there are no real codemods yet**                                                                                                                                                                                 |

## Concepts

- **`.sold/base-version`**: the exact Base version this repository is pinned to (`1.0.0`). Written only by `upgrade:plan`.
- **`.sold/base-manifest.json`**: three lists of path patterns. **Base-owned** paths are replaced on upgrade and must not be edited in an instance; **customer-owned** paths (`extensions/`, `sold.config.ts`, `config/<env>.ts`, `environments/`, `ops/terraform/environments/<customer>/`, `docs/instance/`, `.github/workflows/instance-*.yml`) are never touched; **generated** paths (`pnpm-lock.yaml`, `.sold/base-version`) are rewritten by tooling. Precedence: generated, then base, then customer. A path in none is _unowned_ and is not policed.
- **Base releases** are git tags `base-v<semver>` on the upstream remote (default name `upstream`).
- **Tagged changelog**: Base's `CHANGELOG.md` has `## <version> - <date>` sections; entries that need attention start with tags, e.g. `- [breaking][migration] Orders gain a currency column`. Tags: `breaking`, `migration`, `infra`, `security`. Untagged bullets are ordinary changes and are not surfaced.
- **Codemods**: TypeScript files in `upgrades/<version>/` (Base-owned), named `NNN-what-it-does.ts`, run in order for every release in `(current, target]`. They receive `SOLD_UPGRADE_FROM` and `SOLD_UPGRADE_TO` and must be **idempotent** and confined to customer-owned paths (`sold.config.ts`, `config/`, `extensions/`, `environments/`).

## The flow

```
upgrade:check  ->  upgrade:plan <version>  ->  review the report  ->  upgrade:apply
      |                    |                                               |
 what is new,        branch upgrade/base-v<version>              gates, push, PR
 what breaks         Base files from upstream, codemods,                  |
                     docs/instance/upgrades/<version>.md          preview env -> dev -> stage -> prod
```

1. **Check.** `pnpm sold upgrade:check` fetches tags from `upstream`, lists newer releases, prints every `[breaking]`, `[migration]`, `[infra]` and `[security]` entry between your version and the target, and a compatibility table for each extension. `--to <version>` picks a target, `--patch-only` limits to patch releases of your minor, `--json` for tooling, `--strict` exits non-zero if an extension is incompatible.
2. **Plan.** `pnpm sold upgrade:plan <version>` (add `--patch-only` for patch upgrades). It refuses a dirty working tree, a target that is not newer, a missing tag or an existing branch. It creates `upgrade/base-v<version>`, checks out the **target release's** version of every Base-owned file (using the target's manifest, so newly owned paths are included), deletes Base-owned files that upstream retired, writes `.sold/base-version`, **installs dependencies** (`pnpm install --no-frozen-lockfile`; skip with `--no-install`; the new Base files bring new packages and the CLI cannot restart on stale `node_modules`), runs the codemods, writes `docs/instance/upgrades/<version>.md` and commits `chore(upgrade): base v<version>`. `--no-commit` leaves it staged.
3. **Review** `docs/instance/upgrades/<version>.md`: tagged changes, extension compatibility, files replaced or removed, **local edits to Base-owned files that were overwritten** (these are drift; move the customisation into an extension), codemods run, and a reviewer checklist.
4. **Apply.** `pnpm sold upgrade:apply [--push]` runs the same gates as CI (install, typecheck, lint, tests, migration lint), commits a refreshed lockfile if extension dependencies changed, refuses if any extension is incompatible, and pushes the branch when asked. Open the PR with the report as its body (the upgrade workflow does this once it exists).
5. **Prove it.** Add the `preview` label for a preview environment (Access-protected, demo data), then merge to deploy dev, and promote: `release.yml` with `promote_to: stage`, then `prod`. Migrations run before traffic shifts and are expand/contract (see [runbook: database](runbooks/database.md)), so a rollback is a redeploy of the previous release.

`--dry-run` on `upgrade:plan` and `upgrade:apply` prints the exact git operations, codemods and gates without changing anything.

### Guarding against drift

Instance repositories run `pnpm sold drift:check` on every PR (the scaffold from `customer:new` includes `.github/workflows/instance-drift.yml`). It fails when a PR changes a Base-owned path outside an `upgrade/*` branch. The manifest is read from the PR's **base branch**, so a PR cannot un-own the files it edits. It does nothing in Base itself (no `.sold/instance.json`).

## Worked example

`acme` runs Base 1.0.0 with one extension, `@acme/loyalty` (`"sold": { "requires": { "base": ">=1.0.0 <2.0.0" } }`). Base 1.1.0 is released.

```console
$ pnpm sold upgrade:check
current Base version: 1.0.0
available: 1.0.1, 1.1.0
target:    1.1.0

BREAKING (1)
  1.1.0  Removed the legacy cart API

MIGRATION (1)
  1.1.0  Orders table gains a nullable currency column; run the migrate job before traffic shifts

SECURITY (2)
  1.0.1  Patched a header parsing issue
  1.1.0  Rotate the session signing key on upgrade

extension compatibility
  COMPATIBLE   @acme/loyalty  requires base >=1.0.0 <2.0.0

next: sold upgrade:plan 1.1.0

$ pnpm sold upgrade:plan 1.1.0 --dry-run
[dry-run] git checkout -b upgrade/base-v1.1.0
[dry-run] take upstream (base-v1.1.0) for 7 Base-owned file(s); remove 1 retired file(s)
[dry-run] write .sold/base-version = 1.1.0
[dry-run] run codemod upgrades/1.1.0/001-rename.ts
[dry-run] run codemod upgrades/1.1.0/002-config.ts
[dry-run] write docs/instance/upgrades/1.1.0.md
[dry-run] git add -A && git commit -m "chore(upgrade): base v1.1.0"

$ pnpm sold upgrade:plan 1.1.0
prepared upgrade/base-v1.1.0: 7 file(s) from base-v1.1.0, 1 removed, 2 codemod(s)
review docs/instance/upgrades/1.1.0.md, then run: sold upgrade:apply

$ pnpm sold upgrade:apply --push
...
upgrade/base-v1.1.0 is ready. Open a PR titled "chore(upgrade): base v1.1.0" with docs/instance/upgrades/1.1.0.md as the body; ...
```

(The `upgrade:check` and `--dry-run` output is real, captured from the CLI against the git fixture the tests use, with the extension renamed for readability. The last two messages follow the CLI's message formats.)

Then: PR CI is green, the `preview` label creates `acme-eph-...`, merge deploys dev, `release.yml` `promote_to: stage` opens the stage promotion PR, and after the canary and soak in stage, `promote_to: prod` opens the prod PR whose merge waits for the approval gate and the deploy-freeze check.

## Patch releases

Use `upgrade:check --patch-only` and `upgrade:plan <x.y.z> --patch-only`: the tool refuses a target that is not a patch of your current minor. Patches carry no `[breaking]` entries by policy; the `[security]` ones should be promoted first.

## Publishing side (for Base maintainers)

1. Update `CHANGELOG.md` with a `## <version> - <date>` section; tag every entry that needs customer attention.
2. If customers must change something, add an idempotent codemod under `upgrades/<version>/`.
3. Keep `.sold/base-manifest.json` current when you add a top-level directory (a new Base directory that is not listed is _unowned_ and would not be replaced on upgrade).
4. **Bump the first-party extensions' `requires.base`** (`extensions/*/package.json` `sold.requires.base` **and** the `requires.base` in each `defineExtension` call; discovery refuses a mismatch) together with `BASE_VERSION`. `first-party-compat.test.ts` fails the release commit if `BASE_VERSION` is outside any first-party range.
5. Tag `base-v<version>` on the commit whose tree is the release. Extension SDK breaking changes bump the major and are `[breaking]`.

## Troubleshooting

| Symptom                                                                   | Cause and fix                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not a Sold repository` / `.sold/base-manifest.json not found`            | Run from the repository root; `pnpm sold` uses the directory you invoked it from.                                                                                                                                                                                                            |
| `must contain an exact SemVer version`                                    | `.sold/base-version` holds anything other than `x.y.z` (a branch name, a range). Set it to the release the tree really matches.                                                                                                                                                              |
| `no base-v<version> tag newer than ...`                                   | The remote is not named `upstream` (pass `--upstream <name>`), tags were not fetched (drop `--no-fetch`), or the release is not published.                                                                                                                                                   |
| `the working tree has uncommitted changes`                                | Commit or stash first; the upgrade must be a clean, reviewable diff.                                                                                                                                                                                                                         |
| `branch upgrade/base-v<version> already exists`                           | A previous attempt exists. Continue on it, or `git branch -D` it and re-plan.                                                                                                                                                                                                                |
| `codemod ... failed` and you are on the upgrade branch with dirty changes | The branch is intentionally left uncommitted. Fix the cause (usually a customer file the codemod could not parse), re-run the codemod by hand (`pnpm exec tsx upgrades/<v>/<file>.ts`), then `git add -A && git commit`. To start over: `git checkout - && git branch -D upgrade/base-v<v>`. |
| Report lists **local edits to Base-owned files that were overwritten**    | Someone edited Base directly. Recover the change from `git log -p <path>` and re-express it as an extension or configuration; if it is a bug, send it upstream.                                                                                                                              |
| `extensions incompatible with Base <v>`                                   | The extension's `sold.requires.base` does not include the target. Update the extension (and its range) in the same PR, or hold the upgrade.                                                                                                                                                  |
| Extension shows `UNKNOWN`                                                 | It declares no `sold.requires.base` (or an invalid range). Declare one; unknown is never treated as compatible.                                                                                                                                                                              |
| `drift:check` fails on a PR                                               | The PR edits a Base-owned path. Move the change into `extensions/` or `sold.config.ts`. If the path should be customer-owned, change it upstream in the manifest (a Base release), not in the PR.                                                                                            |
| `drift:check` says it cannot compare against `origin/main`                | CI checked out with a shallow clone. Use `fetch-depth: 0`.                                                                                                                                                                                                                                   |
| `upgrade:apply` gate fails after a clean plan                             | The upgrade is genuinely incompatible with the instance: read the failure, fix on the branch, run `upgrade:apply` again. Do not skip gates (`--skip-gates` exists for a laptop where they already ran).                                                                                      |
| Lockfile changes after `upgrade:apply`                                    | Expected when extensions depend on packages Base changed; it is committed as `chore(upgrade): refresh lockfile`.                                                                                                                                                                             |

## Rehearsal (Phase 8, local only)

Not a real upgrade (no customer, no codemods, a throwaway upstream), but every command ran for real against real git:

1. `customer:new acme` scaffolded a 32-file overlay; laid over a Base checkout it installs, `sold drift:check` passes for a customer-owned edit and fails (naming the file) for a Base-owned one.
2. A scratch upstream with tags `base-v0.1.0` (the previous release) and `base-v0.2.0`; `upgrade:check` listed the tagged changelog entries.
3. **It found three real problems, all fixed:** (a) `upgrade:check` judged first-party extensions by their _installed_ `requires.base`, but the upgrade replaces them, so every minor bump on 0.x blocked itself. Base-owned extensions are now reported as `replaced` and re-checked by `upgrade:apply` after replacement. (b) `upgrade:plan` replaced Base files but did not install, so `upgrade:apply` crashed at start on a missing new dependency (`cron-parser`); `plan` now installs first. (c) a release that bumped `package.json` ranges but not the manifests was refused by the discovery test, which is the gate working; the release procedure above now says to bump both.
4. `upgrade:plan 0.2.0` produced `upgrade/base-v0.2.0` (824 Base files from the tag, 2 retired) and the report; `upgrade:apply` ran the gates (see the PROGRESS ledger for the final outcome).
5. Separately, `ops/drills/n-minus-1.sh` proves the previous release's code runs on the new schema (rollback safety).

**Not rehearsed:** a Base upgrade with real codemods, extension updates that need code changes, a customer database with real data volume, and the promotion `preview → dev → stage → prod` (needs a cloud).
