import type { CliContext } from './lib/context';
import { ExitCode } from './lib/errors';

/**
 * Commands that exist so the surface is discoverable but are not part of Phase 0. They print a clear
 * message and exit non-zero, so no script mistakes them for success.
 */
export function notImplemented(
  ctx: CliContext,
  command: string,
  phase: string,
  detail: string,
): number {
  ctx.out.error(`${command}: not implemented in Phase 0. ${detail} Planned for ${phase}.`);
  return ExitCode.notImplemented;
}

export const stubDetails = {
  'data:snapshot': {
    phase: 'phase-7',
    detail:
      'It will snapshot a database with --anonymise so no real PII ever reaches a non-production environment.',
  },
  'content:export': {
    phase: 'phase-4',
    detail: 'It will export page-builder content and media references.',
  },
  'content:import': {
    phase: 'phase-4',
    detail: 'It will import page-builder content into an environment.',
  },
} as const;
