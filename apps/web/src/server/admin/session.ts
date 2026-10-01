import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { can, type ResolvedUser } from '@sold/identity';
import { currentSession } from '../identity';

/** The signed-in staff user for a server-rendered admin page, or a redirect to sign in. */
export async function requireStaff(): Promise<ResolvedUser> {
  const jar = await cookies();
  const header = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = await currentSession(header, 'staff');
  if (!session) redirect('/admin/login');
  return session.user;
}

export const allowed = (user: ResolvedUser, permission: string): boolean =>
  can(user.permissions, permission);
