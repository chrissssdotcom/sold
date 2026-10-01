import { json } from '../../../../../server/commerce-http';
import { currentSession } from '../../../../../server/identity';
import { route } from '../../../../../server/route';
import { PRIVATE } from '../../../../../server/storefront';

export const dynamic = 'force-dynamic';

export const GET = route(async (request) => {
  const s = await currentSession(request.headers.get('cookie'), 'staff');
  return json(
    {
      user: s
        ? { id: s.user.id, email: s.user.email, name: s.user.name, permissions: s.user.permissions }
        : null,
    },
    { headers: PRIVATE },
  );
});
