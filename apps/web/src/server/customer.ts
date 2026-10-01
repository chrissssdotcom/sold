import { cookies } from 'next/headers';
import { currentSession } from './identity';

/** The signed-in customer for a server-rendered storefront page, or null. */
export async function currentCustomer() {
  const jar = await cookies();
  const header = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = await currentSession(header, 'customer');
  return session?.user ?? null;
}
