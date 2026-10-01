import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { AuthError } from './errors';

export interface OidcConfig {
  /** Stable key for this provider in `identity_links.provider` (e.g. `okta`). Never change it once users are linked. */
  id: string;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes?: string[];
  /** Only these email domains may sign in (lower-case). Empty/undefined = any domain the IdP vouches for. */
  allowedEmailDomains?: string[];
  /** Link to an existing staff account whose email matches (requires a VERIFIED email from the IdP). Off by default. */
  autoLinkByEmail?: boolean;
  /** Create a staff account on first sign-in. Off by default. */
  autoProvision?: boolean;
  defaultRoles?: string[];
  /** IdP group -> Sold roles. When set, the user's roles are re-synchronised from their groups at every sign-in. */
  groupRoleMap?: Record<string, string[]>;
  groupsClaim?: string;
  clockToleranceSeconds?: number;
  fetch?: typeof fetch;
}

export class SsoError extends AuthError {
  constructor(
    readonly reason: string,
    message = 'Single sign-on failed',
  ) {
    super('sso_failed', message, 401, { reason });
  }
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface OidcStart {
  url: string;
  /** Persist these (sealed, short-lived, HttpOnly) and hand them back to `finish`. */
  saved: { state: string; nonce: string; verifier: string };
}

export interface OidcIdentity {
  provider: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string;
  groups: string[];
}

const ALLOWED_ALGS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
];
const b64 = (b: Buffer) => b.toString('base64url');

function assertSecureUrl(raw: string, what: string): URL {
  const u = new URL(raw);
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local))
    throw new SsoError('insecure_endpoint', `${what} must use https`);
  return u;
}

/** OpenID Connect authorization-code flow with PKCE (S256), discovery and strict ID-token validation. */
export class OidcClient {
  private discovery: { doc: Discovery; at: number } | null = null;
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(readonly config: OidcConfig) {
    assertSecureUrl(config.issuer, 'issuer');
  }

  private get f(): typeof fetch {
    return this.config.fetch ?? fetch;
  }

  async discover(): Promise<Discovery> {
    if (this.discovery && Date.now() - this.discovery.at < 3_600_000) return this.discovery.doc;
    const url = `${this.config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const res = await this.f(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new SsoError('discovery_failed');
    const doc = (await res.json()) as Partial<Discovery>;
    // The document must describe THIS issuer: otherwise a compromised or mistyped metadata URL redirects trust elsewhere.
    if (doc.issuer !== this.config.issuer) throw new SsoError('issuer_mismatch');
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
      if (!doc[k]) throw new SsoError('discovery_incomplete');
      assertSecureUrl(doc[k] as string, k);
    }
    this.discovery = { doc: doc as Discovery, at: Date.now() };
    return doc as Discovery;
  }

  async start(): Promise<OidcStart> {
    const d = await this.discover();
    const state = b64(randomBytes(24));
    const nonce = b64(randomBytes(24));
    const verifier = b64(randomBytes(48));
    const challenge = b64(createHash('sha256').update(verifier).digest());
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: (this.config.scopes ?? ['openid', 'email', 'profile']).join(' '),
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    return { url: url.toString(), saved: { state, nonce, verifier } };
  }

  /** Exchange the code and return the verified identity. Every failure is an `SsoError` with a machine reason (logged, not shown). */
  async finish(
    query: { code?: string | null; state?: string | null; error?: string | null },
    saved: { state: string; nonce: string; verifier: string },
  ): Promise<OidcIdentity> {
    if (query.error) throw new SsoError('provider_error');
    if (!query.code || !query.state) throw new SsoError('missing_params');
    if (query.state.length !== saved.state.length || !timingEqual(query.state, saved.state))
      throw new SsoError('state_mismatch');
    const d = await this.discover();

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: query.code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      code_verifier: saved.verifier,
    });
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    if (this.config.clientSecret)
      headers['authorization'] =
        `Basic ${Buffer.from(`${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`).toString('base64')}`;
    const res = await this.f(d.token_endpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new SsoError('token_exchange_failed');
    const tokens = (await res.json()) as { id_token?: string };
    if (!tokens.id_token) throw new SsoError('no_id_token');

    this.jwks ??= createRemoteJWKSet(assertSecureUrl(d.jwks_uri, 'jwks_uri'), {
      timeoutDuration: 8_000,
    });
    let payload: JWTPayload & {
      nonce?: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
      azp?: string;
    };
    try {
      ({ payload } = await jwtVerify(tokens.id_token, this.jwks, {
        issuer: this.config.issuer,
        audience: this.config.clientId,
        algorithms: ALLOWED_ALGS, // never `none`, never HMAC with a shared secret
        clockTolerance: this.config.clockToleranceSeconds ?? 30,
        requiredClaims: ['sub', 'exp', 'iat'],
      }));
    } catch {
      throw new SsoError('id_token_invalid');
    }
    if (!payload.nonce || !timingEqual(payload.nonce, saved.nonce))
      throw new SsoError('nonce_mismatch');
    if (
      Array.isArray(payload.aud) &&
      payload.aud.length > 1 &&
      payload.azp !== this.config.clientId
    )
      throw new SsoError('azp_mismatch');
    if (!payload.sub || payload.sub.length > 255) throw new SsoError('bad_subject');

    const claim = this.config.groupsClaim ?? 'groups';
    const rawGroups = (payload as Record<string, unknown>)[claim];
    return {
      provider: this.config.id,
      subject: payload.sub,
      email: typeof payload.email === 'string' ? payload.email.toLowerCase() : null,
      emailVerified: payload.email_verified === true,
      name: typeof payload.name === 'string' ? payload.name.slice(0, 120) : '',
      groups: Array.isArray(rawGroups)
        ? rawGroups.filter((g): g is string => typeof g === 'string')
        : [],
    };
  }
}

function timingEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
