/** Expected failures: printed without a stack trace and mapped to a process exit code. */
export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/** Exit codes. Stable: workflows branch on them. */
export const ExitCode = {
  ok: 0,
  failure: 1,
  usage: 2,
  /** `env:down --verify` found resources that should be gone. */
  leftovers: 3,
  /** A safety guard refused the operation (prod, concurrency, TTL, dirty tree, drift). */
  refused: 4,
  /** Command exists but is not implemented in this phase. */
  notImplemented: 5,
  /** `env:plan` found changes (drift, or a pending change). Not an error. */
  changes: 6,
} as const;
