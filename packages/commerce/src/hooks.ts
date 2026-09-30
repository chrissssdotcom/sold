import type { HookMap, HookName, Veto } from '@sold/extension-sdk';

/**
 * The slice of the extension kernel's interceptor runner that commerce needs. Injected, so commerce
 * has no dependency on the kernel and tests can supply their own. The runner never throws: a misbehaving
 * extension surfaces as a veto or is bypassed according to its declared fail policy.
 */
export interface HookRunner {
  run<H extends HookName>(
    hook: H,
    input: HookMap[H]['payload'],
  ): Promise<{ payload: HookMap[H]['payload']; veto: Veto | null }>;
}

export const noHooks: HookRunner = {
  async run(_hook, input) {
    return { payload: input, veto: null };
  },
};
