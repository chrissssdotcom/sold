import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignedXml } from 'xml-crypto';

export interface IdpKeys {
  cert: string;
  key: string;
}

/** A throwaway self-signed IdP signing key pair (openssl). */
export function generateIdpKeys(cn = 'test-idp'): IdpKeys {
  const dir = mkdtempSync(join(tmpdir(), 'saml-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(dir, 'k.pem'),
        '-out',
        join(dir, 'c.pem'),
        '-days',
        '2',
        '-subj',
        `/CN=${cn}`,
      ],
      { stdio: 'ignore' },
    );
    return {
      cert: readFileSync(join(dir, 'c.pem'), 'utf8'),
      key: readFileSync(join(dir, 'k.pem'), 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface AssertionOptions {
  issuer: string;
  audience: string;
  recipient: string;
  inResponseTo: string;
  nameId?: string;
  attributes?: Record<string, string | string[]>;
  assertionId?: string;
  notBefore?: Date;
  notOnOrAfter?: Date;
  issueInstant?: Date;
  sign?: boolean;
  keys: IdpKeys;
}

const iso = (d: Date) => d.toISOString();
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/** Build a SAML Response (base64) with a signed Assertion, with every knob an attack test needs. */
export function buildSamlResponse(o: AssertionOptions): string {
  const now = new Date();
  const id = o.assertionId ?? `_a${Math.random().toString(36).slice(2)}`;
  const attrs = Object.entries(o.attributes ?? {})
    .map(
      ([k, v]) =>
        `<saml:Attribute Name="${esc(k)}">${(Array.isArray(v) ? v : [v]).map((x) => `<saml:AttributeValue>${esc(x)}</saml:AttributeValue>`).join('')}</saml:Attribute>`,
    )
    .join('');
  const assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${iso(o.issueInstant ?? now)}">` +
    `<saml:Issuer>${esc(o.issuer)}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${esc(o.nameId ?? 'staff@example.com')}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${esc(o.inResponseTo)}" NotOnOrAfter="${iso(o.notOnOrAfter ?? new Date(now.getTime() + 300_000))}" Recipient="${esc(o.recipient)}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(o.notBefore ?? new Date(now.getTime() - 60_000))}" NotOnOrAfter="${iso(o.notOnOrAfter ?? new Date(now.getTime() + 300_000))}"><saml:AudienceRestriction><saml:Audience>${esc(o.audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(now)}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement>${attrs}</saml:AttributeStatement></saml:Assertion>`;
  let signed = assertion;
  if (o.sign !== false) {
    const sig = new SignedXml({
      privateKey: o.keys.key,
      publicCert: o.keys.cert,
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    });
    sig.addReference({
      xpath: "//*[local-name(.)='Assertion']",
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
      transforms: [
        'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
        'http://www.w3.org/2001/10/xml-exc-c14n#',
      ],
    });
    sig.computeSignature(assertion, {
      location: { reference: "//*[local-name(.)='Issuer']", action: 'after' },
    });
    signed = sig.getSignedXml();
  }
  const response = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${Math.random().toString(36).slice(2)}" Version="2.0" IssueInstant="${iso(now)}" Destination="${esc(o.recipient)}" InResponseTo="${esc(o.inResponseTo)}"><saml:Issuer>${esc(o.issuer)}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${signed}</samlp:Response>`;
  return Buffer.from(response).toString('base64');
}
