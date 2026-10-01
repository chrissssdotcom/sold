import { randomBytes } from 'node:crypto';
import { SAML, ValidateInResponseTo } from '@node-saml/node-saml';
import { sql, type PrimaryDb } from '@sold/db';
import { SsoError, type OidcIdentity } from './oidc';

export interface SamlConfig {
  /** Stable key for `identity_links.provider`. Never change it once users are linked. */
  id: string;
  /** The IdP's single-sign-on URL (HTTP-Redirect binding for the request). */
  entryPoint: string;
  /** Our entity ID (SP issuer). Also the audience an assertion must be addressed to. */
  issuer: string;
  /** Our assertion consumer service URL (HTTP-POST binding). */
  callbackUrl: string;
  /** The IdP's signing certificate(s), PEM. Several are accepted to allow rotation. */
  idpCert: string | string[];
  emailAttribute?: string;
  nameAttribute?: string;
  groupsAttribute?: string;
  clockSkewSeconds?: number;
  /** Maximum age of the assertion's IssueInstant, regardless of its own validity window. */
  maxAssertionAgeSeconds?: number;
  /** Also require the Response envelope to be signed (in addition to the assertion). Off by default. */
  requireSignedResponse?: boolean;
}

export interface SamlStart {
  url: string;
  saved: { requestId: string };
}

const first = (v: unknown): string | null =>
  typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : null;

/**
 * SAML 2.0 Web Browser SSO (SP-initiated). Signature verification, audience, recipient and validity-window checks are done by
 * node-saml (assertions MUST be signed); on top of that we bind the response to OUR request (`InResponseTo`), reject replays of an
 * accepted assertion, and bound the assertion's age. IdP-initiated (unsolicited) responses are refused by design.
 */
export class SamlClient {
  constructor(readonly config: SamlConfig) {}

  private saml(requestId?: string): SAML {
    const c = this.config;
    return new SAML({
      entryPoint: c.entryPoint,
      issuer: c.issuer,
      callbackUrl: c.callbackUrl,
      idpCert: c.idpCert,
      audience: c.issuer,
      wantAssertionsSigned: true,
      // The assertion carries the identity and is always required to be signed; some IdPs also sign the Response envelope.
      wantAuthnResponseSigned: c.requireSignedResponse ?? false,
      signatureAlgorithm: 'sha256',
      digestAlgorithm: 'sha256',
      acceptedClockSkewMs: (c.clockSkewSeconds ?? 30) * 1000,
      // We validate InResponseTo ourselves against the sealed request id: no per-instance in-memory cache to lose.
      validateInResponseTo: ValidateInResponseTo.never,
      disableRequestedAuthnContext: true,
      identifierFormat: null,
      ...(requestId ? { generateUniqueId: () => requestId } : {}),
    });
  }

  async start(): Promise<SamlStart> {
    const requestId = `_${randomBytes(20).toString('hex')}`;
    const url = await this.saml(requestId).getAuthorizeUrlAsync('', undefined, {});
    return { url, saved: { requestId } };
  }

  async finish(
    form: { SAMLResponse?: string | null },
    saved: { requestId: string },
    db: PrimaryDb,
  ): Promise<OidcIdentity> {
    if (!form.SAMLResponse || form.SAMLResponse.length > 200_000)
      throw new SsoError('missing_response');
    let profile: Awaited<ReturnType<SAML['validatePostResponseAsync']>>['profile'];
    try {
      ({ profile } = await this.saml().validatePostResponseAsync({
        SAMLResponse: form.SAMLResponse,
      }));
    } catch {
      throw new SsoError('saml_invalid');
    }
    if (!profile) throw new SsoError('saml_invalid');
    // Bound to the request this browser started.
    if (!profile.inResponseTo || profile.inResponseTo !== saved.requestId)
      throw new SsoError('in_response_to_mismatch');
    const nameId = profile.nameID;
    // The assertion XML node-saml returns is the one whose signature it just verified: read the facts we must check from it.
    const xml = profile.getAssertionXml?.();
    if (!xml) throw new SsoError('saml_incomplete');
    const assertionId = /^<[\w:]*Assertion\b[^>]*\bID="([^"]{1,200})"/.exec(xml.trim())?.[1];
    const issuedAt = Date.parse(
      /^<[\w:]*Assertion\b[^>]*\bIssueInstant="([^"]+)"/.exec(xml.trim())?.[1] ?? '',
    );
    const recipients = [
      ...xml.matchAll(/<[\w:]*SubjectConfirmationData\b[^>]*\bRecipient="([^"]+)"/g),
    ].map((m) => m[1]);
    if (!assertionId || !nameId || Number.isNaN(issuedAt)) throw new SsoError('saml_incomplete');
    // The bearer confirmation must be addressed to OUR assertion consumer URL, or it was minted for another service.
    if (!recipients.includes(this.config.callbackUrl)) throw new SsoError('recipient_mismatch');
    const ageMs = Date.now() - issuedAt;
    const skewMs = (this.config.clockSkewSeconds ?? 30) * 1000;
    if (ageMs > (this.config.maxAssertionAgeSeconds ?? 600) * 1000 + skewMs || ageMs < -skewMs)
      throw new SsoError('assertion_age');
    const attrs = profile as unknown as Record<string, unknown>;

    // Replay: an assertion ID is accepted once. Keep it until it could no longer be valid anyway.
    const keepSeconds =
      (this.config.maxAssertionAgeSeconds ?? 600) + (this.config.clockSkewSeconds ?? 30);
    const inserted = await db.execute(sql`
      INSERT INTO sso_replay (provider, assertion_id, expires_at) VALUES (${this.config.id}, ${assertionId}, now() + make_interval(secs => ${keepSeconds}))
      ON CONFLICT DO NOTHING RETURNING assertion_id`);
    if (inserted.rows.length === 0) throw new SsoError('replay');

    const email =
      first(attrs[this.config.emailAttribute ?? 'email']) ?? (nameId.includes('@') ? nameId : null);
    const groupsRaw = attrs[this.config.groupsAttribute ?? 'groups'];
    return {
      provider: this.config.id,
      subject: nameId.slice(0, 255),
      email: email?.toLowerCase() ?? null,
      // The IdP signed this assertion and the operator trusts it for these users: its email is as verified as it gets.
      emailVerified: email !== null,
      name: (first(attrs[this.config.nameAttribute ?? 'displayName']) ?? '').slice(0, 120),
      groups: Array.isArray(groupsRaw)
        ? groupsRaw.filter((g): g is string => typeof g === 'string')
        : typeof groupsRaw === 'string'
          ? [groupsRaw]
          : [],
    };
  }

  /** Remove expired replay records. Cheap; run from the worker. */
  static async sweep(db: PrimaryDb): Promise<number> {
    return (
      await db.execute(sql`DELETE FROM sso_replay WHERE expires_at < now() RETURNING assertion_id`)
    ).rows.length;
  }
}
