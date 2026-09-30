import type { EnvironmentName } from './schema';

/**
 * Non-prod safety switches (Section 8C.1). These are configuration derived from the
 * environment name, never code paths: the same build runs everywhere.
 */
export interface SafetySwitches {
  /** Only Stripe test-mode keys may be used. */
  stripeTestModeOnly: boolean;
  /** `capture` stores emails in the DB for viewing in admin; nothing leaves the environment. */
  emailTransport: 'production' | 'capture';
  /** Outbound webhooks, social and pixel calls go to sinks. */
  outboundSinks: boolean;
  /** Emit `X-Robots-Tag: noindex` and a disallow-all robots.txt. */
  blockIndexing: boolean;
  /** Real customer PII must never be loaded (seed or anonymised snapshots only). */
  allowRealPii: boolean;
}

export function safetySwitchesFor(environment: EnvironmentName): SafetySwitches {
  if (environment === 'prod') {
    return {
      stripeTestModeOnly: false,
      emailTransport: 'production',
      outboundSinks: false,
      blockIndexing: false,
      allowRealPii: true,
    };
  }
  return {
    stripeTestModeOnly: true,
    emailTransport: 'capture',
    outboundSinks: true,
    blockIndexing: true,
    allowRealPii: false,
  };
}
