import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

/** A minimal OpenID Provider for tests: discovery, JWKS, and an authorization-code token endpoint that enforces PKCE. */
export interface FakeIdp {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Mint the code the browser would bring back after sign-in, bound to a challenge, with chosen ID-token claims. */
  authorize(params: {
    challenge: string;
    nonce: string;
    claims?: Record<string, unknown>;
    header?: Record<string, unknown>;
  }): string;
  tamper: { discoveryIssuer?: string };
  close(): Promise<void>;
  tokenRequests: URLSearchParams[];
}

export async function startFakeIdp(): Promise<FakeIdp> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<
    string,
    {
      challenge: string;
      nonce: string;
      claims: Record<string, unknown>;
      header: Record<string, unknown>;
    }
  >();
  const clientId = 'sold-test-client';
  const clientSecret = 'sold-test-secret';
  const redirectUri = 'http://localhost/callback';
  const tokenRequests: URLSearchParams[] = [];
  const tamper: FakeIdp['tamper'] = {};
  let issuer = '';

  const server: Server = createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/.well-known/openid-configuration')
      return json(200, {
        issuer: tamper.discoveryIssuer ?? issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      });
    if (req.url === '/jwks') return json(200, { keys: [jwk] });
    if (req.url === '/token' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', async () => {
        const body = new URLSearchParams(Buffer.concat(chunks).toString());
        tokenRequests.push(body);
        const entry = codes.get(body.get('code') ?? '');
        codes.delete(body.get('code') ?? ''); // single use
        const basic = req.headers.authorization ?? '';
        if (
          !entry ||
          basic !== `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
        )
          return json(400, { error: 'invalid_grant' });
        const verifier = body.get('code_verifier') ?? '';
        if (createHash('sha256').update(verifier).digest('base64url') !== entry.challenge)
          return json(400, {
            error: 'invalid_grant',
            error_description: 'PKCE verification failed',
          });
        const now = Math.floor(Date.now() / 1000);
        const claims: Record<string, unknown> = {
          sub: 'user-1',
          email: 'staff@example.com',
          email_verified: true,
          name: 'Sam Staff',
          nonce: entry.nonce,
          ...entry.claims,
        };
        const jwt = new SignJWT(claims).setProtectedHeader({
          alg: 'RS256',
          kid: 'k1',
          ...entry.header,
        });
        if (claims['iss'] === undefined) jwt.setIssuer(issuer);
        if (claims['aud'] === undefined) jwt.setAudience(clientId);
        if (claims['iat'] === undefined) jwt.setIssuedAt(now);
        if (claims['exp'] === undefined) jwt.setExpirationTime(now + 300);
        json(200, {
          access_token: 'at',
          token_type: 'Bearer',
          id_token: await jwt.sign(privateKey),
        });
      });
      return;
    }
    json(404, { error: 'not_found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    issuer,
    clientId,
    clientSecret,
    redirectUri,
    tamper,
    tokenRequests,
    authorize: ({ challenge, nonce, claims = {}, header = {} }) => {
      const code = randomUUID();
      codes.set(code, { challenge, nonce, claims, header });
      return code;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
