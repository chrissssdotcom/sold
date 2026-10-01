import { MediaRejected } from '@sold/media';
import { ValidationError } from '@sold/commerce';
import { adminRoute } from '../../../../server/admin-route';
import { json, readBytes } from '../../../../server/commerce-http';
import { getMedia } from '../../../../server/media';
import { LIMITS } from '@sold/media';

export const dynamic = 'force-dynamic';

export const GET = adminRoute('content:read', async (req, { db }) => {
  const sp = new URL(req.url).searchParams;
  const before = sp.get('before');
  const page = await getMedia().list(db, {
    limit: Number(sp.get('limit') ?? 30) || 30,
    ...(before && /^[0-9a-f-]{36}$/.test(before) ? { before } : {}),
  });
  return json({
    items: page.items.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })),
    nextCursor: page.nextCursor,
  });
});

/** Upload: the raw image bytes as the body, `?name=` for the original file name. Re-encoded and stripped of metadata on the way in. */
export const POST = adminRoute(
  'content:write',
  async (req, { db, audit, user }) => {
    const name = new URL(req.url).searchParams.get('name') ?? 'upload';
    const data = await readBytes(req, LIMITS.maxBytes);
    try {
      const { asset, created } = await getMedia().upload(db, { data, name, createdBy: user.email });
      if (created)
        await audit(
          'media.uploaded',
          { type: 'media', id: asset.id },
          { name: asset.originalName, bytes: asset.bytes },
        );
      return json(
        { asset: { ...asset, createdAt: asset.createdAt.toISOString() }, created },
        { status: created ? 201 : 200 },
      );
    } catch (error) {
      if (error instanceof MediaRejected || (error as Error).name === 'MediaRejected')
        throw new ValidationError((error as Error).message, {
          code: (error as MediaRejected).code,
        });
      throw error;
    }
  },
  { binaryBody: true },
);
