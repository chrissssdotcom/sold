import { hkdfSync } from 'node:crypto';
import { OidcClient, SamlClient, type OidcConfig, type SamlConfig } from '@sold/identity';
import instanceConfig from '../../../../sold.config';
import { getRuntime } from './runtime';

const holder = globalThis as unknown as {
  __soldSso?: { oidc?: OidcClient | null; saml?: SamlClient | null };
};
const slot = (holder.__soldSso ??= {});

function publicUrl(): string {
  return (process.env['SOLD_PUBLIC_URL'] ?? 'http://localhost:3000').replace(/\/$/, '');
}

export function oidcClient(): OidcClient | null {
  if (slot.oidc !== undefined) return slot.oidc;
  const c = instanceConfig.identity.oidc;
  if (!c) return (slot.oidc = null);
  const secret = c.clientSecretEnv ? process.env[c.clientSecretEnv] : undefined;
  if (c.clientSecretEnv && !secret)
    throw new Error(
      `identity.oidc.clientSecretEnv is "${c.clientSecretEnv}" but that variable is not set`,
    );
  const config: OidcConfig = {
    id: c.id,
    issuer: c.issuer,
    clientId: c.clientId,
    redirectUri: `${publicUrl()}/api/admin/auth/oidc/callback`,
    autoLinkByEmail: c.autoLinkByEmail,
    autoProvision: c.autoProvision,
    defaultRoles: c.defaultRoles,
    ...(secret ? { clientSecret: secret } : {}),
    ...(c.scopes ? { scopes: c.scopes } : {}),
    ...(c.allowedEmailDomains ? { allowedEmailDomains: c.allowedEmailDomains } : {}),
    ...(c.groupsClaim ? { groupsClaim: c.groupsClaim } : {}),
    ...(c.groupRoleMap ? { groupRoleMap: c.groupRoleMap } : {}),
  };
  return (slot.oidc = new OidcClient(config));
}

export function samlClient(): SamlClient | null {
  if (slot.saml !== undefined) return slot.saml;
  const c = instanceConfig.identity.saml;
  if (!c) return (slot.saml = null);
  const cert = c.idpCert ?? (c.idpCertEnv ? process.env[c.idpCertEnv] : undefined);
  if (!cert) throw new Error('identity.saml needs idpCert or idpCertEnv');
  const config: SamlConfig = {
    id: c.id,
    entryPoint: c.entryPoint,
    issuer: c.issuer ?? `${publicUrl()}/api/admin/auth/saml/metadata`,
    callbackUrl: `${publicUrl()}/api/admin/auth/saml/acs`,
    idpCert: cert,
    ...(c.emailAttribute ? { emailAttribute: c.emailAttribute } : {}),
    ...(c.nameAttribute ? { nameAttribute: c.nameAttribute } : {}),
    ...(c.groupsAttribute ? { groupsAttribute: c.groupsAttribute } : {}),
  };
  return (slot.saml = new SamlClient(config));
}

/** Provisioning rules for a method (kept with the config, applied by `completeSsoLogin`). */
export function ssoRules(kind: 'oidc' | 'saml') {
  const c = kind === 'oidc' ? instanceConfig.identity.oidc : instanceConfig.identity.saml;
  return {
    autoProvision: c?.autoProvision ?? false,
    autoLinkByEmail: c?.autoLinkByEmail ?? false,
    defaultRoles: c?.defaultRoles ?? [],
    ...(c?.allowedEmailDomains ? { allowedEmailDomains: c.allowedEmailDomains } : {}),
    ...(c?.groupRoleMap ? { groupRoleMap: c.groupRoleMap } : {}),
  };
}

export function ssoMethods() {
  const o = instanceConfig.identity.oidc;
  const s = instanceConfig.identity.saml;
  return {
    oidc: o ? { label: o.label, start: '/api/admin/auth/oidc/start' } : null,
    saml: s ? { label: s.label, start: '/api/admin/auth/saml/start' } : null,
  };
}

const LOCAL_DEV_ROOT = Buffer.alloc(32, 'sold-local-dev-key-not-a-secret').toString('base64');

/** The key sealing SSO state cookies: HKDF of the instance secret under its own context string. */
export function ssoStateKey(): Buffer {
  const env = getRuntime().env;
  const root = env.SOLD_SECRET_KEY ?? (env.SOLD_ENVIRONMENT === 'local' ? LOCAL_DEV_ROOT : null);
  if (!root) throw new Error('SOLD_SECRET_KEY is required for SSO');
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(root, 'base64'), Buffer.alloc(0), 'sold:sso-state:v1', 32),
  );
}
