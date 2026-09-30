import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { CliContext } from '../lib/context';
import { CliError, ExitCode } from '../lib/errors';

const timestamp = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'must be an RFC 3339 timestamp');

/** `environments/prod/freeze.json` (customer-owned): windows in which production must not change. */
export const freezeFileSchema = z
  .object({
    windows: z.array(
      z
        .object({ from: timestamp, to: timestamp, reason: z.string().min(1) })
        .refine((w) => Date.parse(w.from) < Date.parse(w.to), {
          message: 'from must be before to',
        }),
    ),
  })
  .strict();

export interface FreezeResult {
  frozen: boolean;
  reasons: string[];
}

export async function evaluateFreeze(ctx: CliContext): Promise<FreezeResult> {
  const reasons: string[] = [];
  if (ctx.env['SOLD_DEPLOY_FREEZE'] === 'true')
    reasons.push('SOLD_DEPLOY_FREEZE=true (repository-wide freeze switch)');

  let text: string | undefined;
  try {
    text = await readFile(join(ctx.cwd, 'environments', 'prod', 'freeze.json'), 'utf8');
  } catch {
    text = undefined;
  }
  if (text !== undefined) {
    const parsed = freezeFileSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      // A malformed freeze file must never silently disable the freeze.
      throw new CliError(
        `environments/prod/freeze.json is invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    const now = ctx.now().getTime();
    for (const w of parsed.data.windows) {
      if (Date.parse(w.from) <= now && now < Date.parse(w.to)) {
        reasons.push(`${w.reason} (${w.from} to ${w.to})`);
      }
    }
  }
  return { frozen: reasons.length > 0, reasons };
}

/**
 * Deploy-freeze gate for production. An emergency override needs an explicit reason, is loudly
 * logged, and is visible in the workflow run that approved it.
 */
export async function checkDeployFreeze(
  ctx: CliContext,
  overrideReason?: string,
): Promise<FreezeResult> {
  const result = await evaluateFreeze(ctx);
  if (!result.frozen) {
    ctx.out.info('deploy freeze: not frozen');
    return result;
  }
  if (overrideReason && overrideReason.trim().length >= 10) {
    ctx.out.warn(
      `DEPLOY FREEZE OVERRIDDEN: ${overrideReason.trim()} (freeze: ${result.reasons.join('; ')})`,
    );
    return result;
  }
  throw new CliError(
    `production deploys are frozen: ${result.reasons.join('; ')}. ` +
      'An emergency override needs a written reason of at least 10 characters (workflow input freeze_override).',
    ExitCode.refused,
  );
}
