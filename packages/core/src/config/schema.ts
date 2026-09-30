import { z } from 'zod';

/** Deployment environment ladder (Section 8C.1). Same code, different config. */
export const environmentNames = ['local', 'ephemeral', 'dev', 'stage', 'prod'] as const;
export type EnvironmentName = (typeof environmentNames)[number];

/** Sizing tiers (Section 8A.1). Orthogonal to the environment. */
export const tierNames = ['standard', 'high-volume', 'event-scale'] as const;
export type TierName = (typeof tierNames)[number];

export const currencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'ISO-4217 currency code (3 upper-case letters)');

export const currencyConfigSchema = z.object({
  code: currencyCodeSchema,
  /** derived: base price x FX x rounding rule; fixed: explicit per-currency prices. */
  strategy: z.enum(['derived', 'fixed']).default('derived'),
  /** e.g. ".99" for derived pricing; interpreted by the pricing engine. */
  rounding: z.string().optional(),
});

const localeSchema = z.string().regex(/^[a-z]{2}(-[A-Za-z]{2,4})?$/, 'BCP-47 style locale');

export const extensionEntrySchema = z.union([
  z.string().min(1),
  z.object({
    name: z.string().min(1),
    enabled: z.boolean().default(true),
    settings: z.record(z.string(), z.unknown()).optional(),
  }),
]);

export const soldConfigSchema = z
  .object({
    instance: z.object({
      /** Human-readable business name. */
      name: z.string().min(1),
      /** Slug of the customer that owns this instance (used in tags and hostnames). */
      customer: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
    }),
    tier: z.enum(tierNames).default('standard'),
    currencies: z
      .object({
        base: currencyCodeSchema,
        enabled: z.array(currencyConfigSchema).min(1),
      })
      .superRefine((value, ctx) => {
        if (!value.enabled.some((c) => c.code === value.base)) {
          ctx.addIssue({
            code: 'custom',
            message: 'The base currency must be included in currencies.enabled',
            path: ['enabled'],
          });
        }
        const codes = value.enabled.map((c) => c.code);
        if (new Set(codes).size !== codes.length) {
          ctx.addIssue({ code: 'custom', message: 'Duplicate currency codes', path: ['enabled'] });
        }
      }),
    locales: z
      .object({
        default: localeSchema,
        enabled: z.array(localeSchema).min(1),
      })
      .refine((v) => v.enabled.includes(v.default), {
        message: 'The default locale must be included in locales.enabled',
        path: ['enabled'],
      }),
    /** Extension package names, in the order they should be considered (load order is still dependency-sorted). */
    extensions: z.array(extensionEntrySchema).default([]),
    gateways: z
      .object({ enabled: z.array(z.string().min(1)).min(1) })
      .default({ enabled: ['manual'] }),
    scale: z
      .object({
        /** Pre-scale switch for scheduled events (Section 8A.3). */
        mode: z.enum(['normal', 'prescale']).default('normal'),
        waitingRoom: z.boolean().default(false),
      })
      .default({ mode: 'normal', waitingRoom: false }),
    theme: z
      .object({
        preset: z.string().default('default'),
        tokens: z.record(z.string(), z.string()).default({}),
      })
      .default({ preset: 'default', tokens: {} }),
  })
  .strict();

export type SoldConfigInput = z.input<typeof soldConfigSchema>;
export type SoldConfig = z.output<typeof soldConfigSchema>;

/** Typed identity helper for `sold.config.ts`; validates at call time. */
export function defineConfig(input: SoldConfigInput): SoldConfig {
  return soldConfigSchema.parse(input);
}

export function normalizeExtensions(
  config: SoldConfig,
): { name: string; enabled: boolean; settings: Record<string, unknown> }[] {
  return config.extensions.map((entry) =>
    typeof entry === 'string'
      ? { name: entry, enabled: true, settings: {} }
      : { name: entry.name, enabled: entry.enabled, settings: entry.settings ?? {} },
  );
}
