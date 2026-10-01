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
    /**
     * Which provider is active for a service when several are registered, e.g.
     * `{ 'pricing.rounding': 'charm-pricing' }`. Overrides precedence; required when two providers tie.
     */
    services: z.record(z.string(), z.string()).default({}),
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
    /**
     * Commerce behaviour that is a business decision rather than code. Shipping zones and tax tables are validated by
     * `@sold/commerce` (`parseShippingConfig`, `parseTaxTable`) so this package stays free of domain dependencies.
     */
    commerce: z
      .object({
        /** Where goods ship from (drives origin-sourced tax rules). */
        origin: z
          .object({
            line1: z.string().min(1),
            city: z.string().min(1),
            region: z.string().default(''),
            postalCode: z.string().min(1),
            country: z.string().length(2),
          })
          .default({
            line1: '1 Example St',
            city: 'Sydney',
            region: 'NSW',
            postalCode: '2000',
            country: 'AU',
          }),
        /** Displayed prices already include tax (AU/NZ/UK/EU style). */
        pricesIncludeTax: z.boolean().default(true),
        /** How long an unpaid order holds its stock. */
        paymentWindowMinutes: z.number().int().min(1).max(1440).default(30),
        /** Redis admission gate in front of Postgres stock holds: for hot-SKU drops. Requires REDIS_URL. */
        inventoryGate: z.boolean().default(false),
        shipping: z.record(z.string(), z.unknown()).optional(),
        tax: z.record(z.string(), z.unknown()).optional(),
      })
      .default({
        origin: {
          line1: '1 Example St',
          city: 'Sydney',
          region: 'NSW',
          postalCode: '2000',
          country: 'AU',
        },
        pricesIncludeTax: true,
        paymentWindowMinutes: 30,
        inventoryGate: false,
      }),
    /**
     * Staff sign-in beyond passwords. Secrets are never in this file: `clientSecretEnv` names the environment variable that
     * holds the OIDC client secret. SSO is off unless configured; SCIM is off unless enabled.
     */
    identity: z
      .object({
        oidc: z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
            label: z.string().max(60).default('Single sign-on'),
            issuer: z.url(),
            clientId: z.string().min(1),
            clientSecretEnv: z
              .string()
              .regex(/^[A-Z][A-Z0-9_]*$/)
              .optional(),
            scopes: z.array(z.string()).optional(),
            allowedEmailDomains: z.array(z.string().toLowerCase()).optional(),
            autoLinkByEmail: z.boolean().default(false),
            autoProvision: z.boolean().default(false),
            defaultRoles: z.array(z.string()).default([]),
            groupsClaim: z.string().optional(),
            groupRoleMap: z.record(z.string(), z.array(z.string())).optional(),
          })
          .optional(),
        saml: z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
            label: z.string().max(60).default('Single sign-on'),
            entryPoint: z.url(),
            /** Our entity id (also the audience). Defaults to `<public url>/api/admin/auth/saml/metadata`. */
            issuer: z.string().optional(),
            /** The IdP's signing certificate(s), PEM (public: safe to keep here), or the env var that holds it. */
            idpCert: z.union([z.string(), z.array(z.string())]).optional(),
            idpCertEnv: z
              .string()
              .regex(/^[A-Z][A-Z0-9_]*$/)
              .optional(),
            emailAttribute: z.string().optional(),
            nameAttribute: z.string().optional(),
            groupsAttribute: z.string().optional(),
            allowedEmailDomains: z.array(z.string().toLowerCase()).optional(),
            autoLinkByEmail: z.boolean().default(false),
            autoProvision: z.boolean().default(false),
            defaultRoles: z.array(z.string()).default([]),
            groupRoleMap: z.record(z.string(), z.array(z.string())).optional(),
          })
          .optional(),
        scim: z
          .object({
            enabled: z.boolean().default(false),
            managedRoles: z.array(z.string()).optional(),
          })
          .default({ enabled: false }),
      })
      .default({ scim: { enabled: false } }),
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
