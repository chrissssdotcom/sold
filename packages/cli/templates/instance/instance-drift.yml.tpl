# Customer-owned. Fails a PR that edits Base-owned paths outside an `upgrade/*` branch.
# Base-owned paths are listed in .sold/base-manifest.json; upgrades replace them wholesale.
name: Ownership drift

on:
  pull_request:

permissions:
  contents: read

jobs:
  drift:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      # Branch names are attacker-controlled: pass them through the environment, never inline in the script.
      - run: pnpm sold drift:check --base-ref "origin/$BASE_REF" --branch "$HEAD_REF"
        env:
          BASE_REF: ${{ github.base_ref }}
          HEAD_REF: ${{ github.head_ref }}
