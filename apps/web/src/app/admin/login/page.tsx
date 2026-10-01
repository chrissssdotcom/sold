import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { currentSession } from '../../../server/identity';
import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sign in' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const jar = await cookies();
  const header = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  if (await currentSession(header, 'staff')) redirect('/admin');
  const { error } = await searchParams;
  return (
    <LoginForm
      initialError={error ? 'Single sign-on failed. Try again or use your password.' : null}
    />
  );
}
