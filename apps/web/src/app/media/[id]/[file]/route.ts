import { getMedia } from '../../../../server/media';
import { getRuntime } from '../../../../server/runtime';

export const dynamic = 'force-dynamic';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE = /^[a-z0-9]+\.[a-z0-9]+$/;

/**
 * Serve a rendition. Asset ids are random and a file never changes once written, so the response is cacheable forever by the
 * CDN and browsers (`immutable`). Only files listed in the catalogue exist; `nosniff` and an inert content type mean an
 * uploaded file can never be interpreted as anything but the image it was re-encoded into.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string; file: string }> }) {
  const { id, file } = await ctx.params;
  if (!ID.test(id) || !FILE.test(file)) return new Response('Not found', { status: 404 });
  const hit = await getMedia().read(getRuntime().db.replica, id, file);
  if (!hit) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(hit.data), {
    headers: {
      'content-type': hit.mime,
      'content-length': String(hit.data.length),
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'content-disposition': 'inline',
    },
  });
}
