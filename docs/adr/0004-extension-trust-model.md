# ADR-0004: Extension trust model

Status: accepted. Supersedes any implication in ADR-0001 that extensions are sandboxed.

## Decision

Extensions are **trusted, reviewed, in-process code**. There is no sandbox: an extension runs in the same Node process as Base and
can, in principle, do anything the process can. We do not claim otherwise.

What we enforce is a set of _guardrails and privilege boundaries_ that stop accidents and limit what a mistake or a lazy
extension can reach:

| Boundary                | Mechanism                                                                                                                                                                                                                                                                                            | Strength                                                                                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database                | Each extension connects as its own NOLOGIN-style role (`sold_ext_<name>`, dedicated pool) granted DML only on its own `ext_<name>_*` tables and SELECT on a documented Base read allowlist. No access to settings, registry, migration journal, flags, outbox, idempotency keys or the queue schema. | Enforced by PostgreSQL privileges (tested with a non-superuser application role). Mode `enforce` is the default outside local and is refused to be turned off in production. |
| Migrations              | Allowlist linter on the PostgreSQL AST; `sold:allow` waivers are ignored for extension rules; exact owned-object tracking for purge.                                                                                                                                                                 | Defence in depth, run in CI and again at apply time.                                                                                                                         |
| Import boundary         | ESLint allowlist: extensions import only `@sold/extension-sdk` and a small set of vetted packages.                                                                                                                                                                                                   | A lint guardrail, bypassable by determined code.                                                                                                                             |
| Hot path (interceptors) | Time budget, bounded concurrency, circuit breaker, network/DNS/child-process guards, failure policy.                                                                                                                                                                                                 | **Best effort.** Detects and contains accidents (slow, throwing, networked interceptors). It cannot preempt synchronous CPU loops or stop deliberately hostile code.         |
| Review                  | First-party or reviewed extensions only; `sold ext:*` tooling shows what an extension asks for.                                                                                                                                                                                                      | The real control.                                                                                                                                                            |

## Consequences

- Never install an extension you would not merge into Base. A hostile extension can read process memory (including the master
  key held for settings decryption) and is outside what these guardrails defend.
- Isolation defends against _mistakes and confused deputies_, not malice: a buggy extension cannot corrupt orders or read another
  extension's data.
- If third-party, untrusted extensions become a requirement, the answer is out-of-process execution (separate service with a
  narrow RPC API), not stronger in-process checks. That would be a new ADR.
