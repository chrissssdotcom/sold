import { buildOpenApi } from '../../../../server/openapi';

export const dynamic = 'force-static';

/** Public: the contract is not a secret, and tooling needs it without a key. */
export function GET() {
  return Response.json(buildOpenApi(process.env['SOLD_VERSION'] ?? '0.0.0'), {
    headers: { 'cache-control': 'public, max-age=300' },
  });
}
