'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../_components/api';

interface Methods {
  password: boolean;
  oidc: { label: string; start: string } | null;
  saml: { label: string; start: string } | null;
}

export function LoginForm({ initialError }: { initialError: string | null }) {
  const router = useRouter();
  const [methods, setMethods] = useState<Methods | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Methods>('GET', '/api/admin/auth/sso')
      .then(setMethods)
      .catch(() => setMethods({ password: true, oidc: null, saml: null }));
  }, []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/admin/auth/login', {
        email: String(form.get('email') ?? ''),
        password: String(form.get('password') ?? ''),
      });
      router.replace('/admin');
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const sso = [methods?.oidc, methods?.saml].filter(Boolean) as { label: string; start: string }[];
  return (
    <div className="login">
      <div className="card">
        <div className="brand">
          <i aria-hidden="true">S</i>Sold admin
        </div>
        <h1 style={{ marginBottom: 4 }}>Sign in</h1>
        <p className="muted" style={{ marginTop: 0 }}>
          Staff access only.
        </p>
        {error ? (
          <div className="alert" role="alert">
            {error}
          </div>
        ) : null}
        {sso.length > 0 ? (
          <>
            <div className="sso-list">
              {sso.map((s) => (
                <a key={s.start} className="btn" href={s.start}>
                  Continue with {s.label}
                </a>
              ))}
            </div>
            {methods?.password ? <div className="divider">or</div> : null}
          </>
        ) : null}
        {methods === null || methods.password ? (
          <form onSubmit={submit}>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                name="email"
                type="email"
                className="input"
                autoComplete="username"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                name="password"
                type="password"
                className="input"
                autoComplete="current-password"
                required
              />
            </div>
            <button className="btn primary" style={{ width: '100%' }} disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        ) : null}
      </div>
    </div>
  );
}
