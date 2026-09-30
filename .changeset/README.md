# Changesets

Base and each extension are versioned independently with SemVer. Every user-visible change adds a changeset
(`pnpm changeset`). Mark migration, infra, security and breaking changes clearly: `sold upgrade:check` surfaces
them to customers. Releases are cut from `main` (see `docs/upgrading.md`).
