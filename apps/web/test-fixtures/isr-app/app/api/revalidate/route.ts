import { revalidatePath, revalidateTag } from 'next/cache';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const body = (await request.json()) as { path?: string; tag?: string };
  if (body.path) revalidatePath(body.path);
  if (body.tag) revalidateTag(body.tag, { expire: 0 });
  return Response.json({ ok: true });
}
