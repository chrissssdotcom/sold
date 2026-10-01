'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { AuthPageProps } from '../../contract';

interface ApiError {
  error?: { message?: string; details?: { issues?: { path: string; message: string }[] } };
}

/** Sign in or create an account. Talks to `/api/auth/*`; the session lives in an HttpOnly cookie the page never sees. */
export function AuthPage({ market, mode }: AuthPageProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/${market.slug}`;
  const register = mode === 'register';

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/auth/${mode}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: String(f.get('email') ?? ''),
        password: String(f.get('password') ?? ''),
        ...(register ? { name: String(f.get('name') ?? '') } : {}),
      }),
    }).catch(() => null);
    if (res?.ok) {
      router.push(`${base}/account`);
      router.refresh();
      return;
    }
    const data = (await res?.json().catch(() => ({}))) as ApiError | undefined;
    const issue = data?.error?.details?.issues?.[0];
    setError(issue?.message ?? data?.error?.message ?? 'Something went wrong. Please try again.');
    setBusy(false);
  }

  return (
    <div className="container" style={{ maxWidth: '28rem' }}>
      <section className="panel" aria-labelledby="auth-h" style={{ marginBlock: '3rem' }}>
        <h1 id="auth-h" style={{ fontSize: 'var(--step-3)' }}>
          {register ? 'Create your account' : 'Welcome back'}
        </h1>
        <p className="muted">
          {register ? 'Track orders and check out faster.' : 'Sign in to see your orders.'}
        </p>
        {error ? (
          <p role="alert" className="alert" style={{ marginBlock: '0.75rem' }}>
            {error}
          </p>
        ) : null}
        <form onSubmit={submit} noValidate={false}>
          {register ? (
            <div className="field">
              <label htmlFor="auth-name">Name</label>
              <input id="auth-name" name="name" autoComplete="name" />
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="auth-email">Email</label>
            <input id="auth-email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="field">
            <label htmlFor="auth-pw">Password</label>
            <input
              id="auth-pw"
              name="password"
              type="password"
              autoComplete={register ? 'new-password' : 'current-password'}
              minLength={register ? 12 : undefined}
              required
            />
            {register ? <span className="muted">At least 12 characters.</span> : null}
          </div>
          <button className="btn btn--primary btn--lg" style={{ width: '100%' }} disabled={busy}>
            {busy ? 'One moment…' : register ? 'Create account' : 'Sign in'}
          </button>
        </form>
        <p style={{ marginTop: '1rem' }}>
          {register ? (
            <>
              Already have an account? <Link href={`${base}/account/login`}>Sign in</Link>
            </>
          ) : (
            <>
              New here? <Link href={`${base}/account/register`}>Create an account</Link>
            </>
          )}
        </p>
      </section>
    </div>
  );
}
