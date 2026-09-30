import type { CliContext } from './context';
import { formatCommand, type RunResult } from './process';
import { CliError } from './errors';

/** One external action. Data, so `--dry-run` can print exactly what would run. */
export interface Step {
  description: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Read-only steps still print in dry-run but are marked as queries. */
  readOnly?: boolean;
  stream?: boolean;
  /** Non-zero exit does not abort (the caller inspects the result). */
  allowFailure?: boolean;
}

export interface StepOutcome {
  step: Step;
  skipped: boolean;
  result?: RunResult;
}

/**
 * Executes (or, with --dry-run, prints) a single step. Failures throw CliError with the command
 * line and captured stderr, never with environment values.
 */
export async function runStep(ctx: CliContext, step: Step): Promise<StepOutcome> {
  const line = formatCommand(step.command, step.args);
  if (ctx.dryRun) {
    ctx.out.info(`[dry-run] ${step.readOnly ? 'query' : 'run'}: ${line}`);
    ctx.out.info(`          ${step.description}`);
    return { step, skipped: true };
  }
  ctx.out.info(`> ${step.description}`);
  const result = await ctx.runner.run(step.command, step.args, {
    cwd: step.cwd ?? ctx.cwd,
    env: step.env,
    stream: step.stream,
  });
  if (result.code !== 0 && !step.allowFailure) {
    const detail = (result.stderr || result.stdout).trim().split('\n').slice(-8).join('\n');
    throw new CliError(
      `${line} failed with exit code ${result.code}${detail ? `\n${detail}` : ''}`,
    );
  }
  return { step, skipped: false, result };
}
