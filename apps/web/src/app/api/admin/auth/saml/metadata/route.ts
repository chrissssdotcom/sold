import { route } from '../../../../../../server/route';
import instanceConfig from '../../../../../../../../../sold.config';

export const dynamic = 'force-dynamic';

/** SP metadata for the IdP administrator (entity id and assertion consumer URL). Public by design. */
export const GET = route(async () => {
  const base = (process.env['SOLD_PUBLIC_URL'] ?? 'http://localhost:3000').replace(/\/$/, '');
  const c = instanceConfig.identity.saml;
  const entity = c?.issuer ?? `${base}/api/admin/auth/saml/metadata`;
  const xml = `<?xml version="1.0"?><EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entity}"><SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat><AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${base}/api/admin/auth/saml/acs" index="0" isDefault="true"/></SPSSODescriptor></EntityDescriptor>`;
  return new Response(xml, { headers: { 'content-type': 'application/samlmetadata+xml' } });
});
